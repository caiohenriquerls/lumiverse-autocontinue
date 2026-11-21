/**
 * Auto-Continue on Connection Loss
 *
 * Lumiverse already survives the browser losing the server: the generation
 * keeps running in the backend pool and the client re-syncs on reconnect. The
 * gap this fills is the other direction - the server losing the provider
 * mid-stream. There the host persists whatever text arrived, marks it partial,
 * shows the error, and waits for a human to press Continue.
 *
 * This extension presses it, and only when the failure looks like a lost
 * connection. The decision lives in ./error-policy.ts, which is fail-closed:
 * billing, credentials, moderation, malformed requests and anything it does
 * not recognise are left alone.
 *
 * Everything runs in the browser. The continue itself goes through the host's
 * own command (`action-continue`, the same one the command palette runs), so
 * the reply is produced exactly as a manual continue would produce it.
 *
 * Every path that declines to continue records why, in the console and in a
 * decision log the settings panel renders. A silent extension is impossible to
 * debug, and "it just did nothing" was exactly the bug report that produced
 * this version.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { classifyGenerationFailure } from './error-policy'
import { pickStrings, type Strings } from './strings'

const SETTINGS_KEY = 'config'
const DECISIONS_KEY = 'decisions'
/**
 * Written once per `setup()`. It is how anyone - including the author, reading
 * the database from outside the browser - can tell which build is actually
 * live in the page, which is a different question from which version the
 * Extensions panel shows: updating an extension does not always replace the
 * module a loaded page is already running.
 */
const STATUS_KEY = 'status'
const CONTINUE_COMMAND = 'action-continue'
const CLAIM_PREFIX = 'spindle:lumi_autocontinue:claim:'
/** How long one document's claim on a chat blocks the other documents. */
const CLAIM_TTL_MS = 15_000
/** Rate-limit failures never retry sooner than this. */
const SLOW_FLOOR_MS = 20_000
const MAX_DELAY_MS = 120_000
/** A new failure this long after the last one starts the attempt count over. */
const ATTEMPT_RESET_MS = 10 * 60_000
/**
 * A generation whose start we saw this long ago is treated as finished even if
 * no terminal event arrived. Without this, one lost GENERATION_ENDED would
 * leave the chat permanently "busy" and quietly disable the extension there.
 */
const RUNNING_TTL_MS = 15 * 60_000
const NOTICE_TTL_MS = 7_000
const MAX_DECISIONS = 20

type Config = {
  enabled: boolean
  maxAttempts: number
  delaySeconds: number
  continueOnTruncated: boolean
  announce: boolean
  blockWords: string
}

const DEFAULTS: Config = {
  enabled: true,
  maxAttempts: 2,
  delaySeconds: 3,
  continueOnTruncated: false,
  announce: true,
  blockWords: '',
}

type Decision = { at: number; chatId: string; text: string }

/** Shape of the host's GENERATION_ENDED payload, as far as this extension reads it. */
type GenerationEndedLike = {
  chatId?: unknown
  generationId?: unknown
  messageId?: unknown
  content?: unknown
  error?: unknown
  errorCode?: unknown
  errorMessage?: unknown
  finish_reason?: unknown
  generationType?: unknown
  frontendSessionId?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN
  if (Number.isNaN(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function normalizeConfig(raw: unknown): Config {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<Config>
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
    maxAttempts: clamp(input.maxAttempts, 1, 5, DEFAULTS.maxAttempts),
    delaySeconds: clamp(input.delaySeconds, 1, 120, DEFAULTS.delaySeconds),
    continueOnTruncated:
      typeof input.continueOnTruncated === 'boolean' ? input.continueOnTruncated : DEFAULTS.continueOnTruncated,
    announce: typeof input.announce === 'boolean' ? input.announce : DEFAULTS.announce,
    blockWords: typeof input.blockWords === 'string' ? input.blockWords : DEFAULTS.blockWords,
  }
}

function parseBlockWords(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3)
}

/** Identifies this document to its own claims, for the lifetime of the page. */
const DOCUMENT_TOKEN = `${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Best-effort cross-document lock, and the only thing standing between two
 * open windows and two continues.
 *
 * The host does not tell an extension which document started a generation:
 * `frontendSessionId` on the payload is whichever session the server currently
 * treats as the execution owner, which with two windows open can be the one
 * you are not looking at. Comparing it against this document's id was how
 * 1.0.0 managed to skip a perfectly continuable failure in silence. So the
 * claim decides, and storage being unavailable must never disable the feature.
 *
 * The claim is re-entrant for the document that holds it: our own second
 * attempt on the same reply arrives well inside the TTL and must not be locked
 * out by our own first one.
 */
function claimChat(chatId: string): boolean {
  const key = `${CLAIM_PREFIX}${chatId}`
  try {
    const now = Date.now()
    const existing = window.localStorage.getItem(key)
    if (existing) {
      const parsed = JSON.parse(existing) as { at?: unknown; token?: unknown }
      const fresh = typeof parsed?.at === 'number' && now - parsed.at < CLAIM_TTL_MS
      if (fresh && parsed?.token !== DOCUMENT_TOKEN) return false
    }
    window.localStorage.setItem(key, JSON.stringify({ at: now, token: DOCUMENT_TOKEN }))
    const readBack = window.localStorage.getItem(key)
    if (!readBack) return true
    return (JSON.parse(readBack) as { token?: unknown })?.token === DOCUMENT_TOKEN
  } catch {
    return true
  }
}

export function setup(ctx: SpindleFrontendContext) {
  const strings = pickStrings()
  const disposers: Array<() => void> = []
  let config: Config = { ...DEFAULTS }
  let destroyed = false

  // ── Status line ───────────────────────────────────────────────────────────
  // A polite live region, so a screen reader announces each decision without
  // stealing focus, and sighted users get the same text as a small pill.
  const removeStyle = ctx.dom.addStyle(`
    .lac-notice {
      position: fixed;
      bottom: 14px;
      left: 50%;
      transform: translateX(-50%);
      max-width: min(520px, 90vw);
      padding: 7px 14px;
      border: 1px solid var(--lumiverse-border, rgba(127,127,127,.4));
      border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-bg-elevated, var(--lumiverse-fill-subtle, rgba(20,20,20,.92)));
      color: var(--lumiverse-text, inherit);
      font-size: 12px;
      line-height: 1.4;
      text-align: center;
      z-index: 2147483000;
      pointer-events: none;
      opacity: 0;
      transition: opacity 140ms ease-in-out;
    }
    .lac-notice[data-visible="true"] { opacity: 1; }
    .lac-settings { display: flex; flex-direction: column; gap: 18px; }
    .lac-row { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; }
    .lac-row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .lac-label { font-size: 13px; font-weight: 600; color: var(--lumiverse-text, inherit); }
    .lac-help { margin: 0; font-size: 12px; line-height: 1.45; color: var(--lumiverse-text-muted, inherit); }
    .lac-control { flex: 0 0 auto; min-width: 96px; display: flex; justify-content: flex-end; }
    .lac-block { display: flex; flex-direction: column; gap: 6px; }
    .lac-policy, .lac-logbox {
      padding: 12px 14px;
      border: 1px solid var(--lumiverse-border, rgba(127,127,127,.4));
      border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-fill-subtle, transparent);
    }
    .lac-policy-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .lac-log { margin: 8px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.6; }
    .lac-log li { color: var(--lumiverse-text-muted, inherit); }
  `)
  disposers.push(removeStyle)

  // `inject` returns its own tracking wrapper, not the markup passed in, so the
  // live region has to be queried back out of it before anything writes to it.
  const noticeWrapper = ctx.dom.inject(
    'body',
    '<div class="lac-notice" role="status" aria-live="polite" aria-atomic="true"></div>',
  )
  const notice = noticeWrapper.querySelector('.lac-notice') ?? noticeWrapper
  let noticeTimer: number | null = null

  // ── Decision log ──────────────────────────────────────────────────────────
  let decisions: Decision[] = []
  let renderLog: (() => void) | null = null

  function record(chatId: string, text: string): void {
    decisions = [{ at: Date.now(), chatId, text }, ...decisions].slice(0, MAX_DECISIONS)
    renderLog?.()
    void ctx.settings?.set(DECISIONS_KEY, decisions).catch(() => {
      /* the in-memory log still works without persistence */
    })
  }

  /** Announce (screen reader + pill), log to the console, and keep the record. */
  function announce(chatId: string, text: string): void {
    if (destroyed) return
    console.info(`[lumi_autocontinue] ${text}`)
    record(chatId, text)
    if (!config.announce) return
    notice.textContent = text
    notice.setAttribute('data-visible', 'true')
    if (noticeTimer !== null) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => {
      noticeTimer = null
      notice.setAttribute('data-visible', 'false')
      notice.textContent = ''
    }, NOTICE_TTL_MS)
  }

  /**
   * A failure that could have been continued but was not. Recorded, never
   * announced out loud: the chat already shows the error, and the point of
   * these lines is that the next "why did nothing happen?" has an answer.
   */
  function skip(chatId: string, text: string): void {
    console.info(`[lumi_autocontinue] ${text}`)
    record(chatId, text)
  }

  disposers.push(() => {
    if (noticeTimer !== null) window.clearTimeout(noticeTimer)
    ctx.dom.uninject(noticeWrapper)
  })

  // ── Live settings ─────────────────────────────────────────────────────────
  const settings = ctx.settings
  if (settings) {
    void settings
      .get<Partial<Config>>(SETTINGS_KEY)
      .then((stored) => {
        if (!destroyed && stored !== undefined) config = normalizeConfig(stored)
      })
      .catch(() => {
        /* keep defaults */
      })
    void settings
      .get<Decision[]>(DECISIONS_KEY)
      .then((stored) => {
        if (destroyed || !Array.isArray(stored)) return
        const restored = stored.filter(
          (entry): entry is Decision =>
            !!entry && typeof entry.at === 'number' && typeof entry.text === 'string',
        )
        // Anything recorded in this session is newer than what was stored.
        decisions = [...decisions, ...restored].slice(0, MAX_DECISIONS)
        renderLog?.()
      })
      .catch(() => {
        /* no history is not an error */
      })
    const unwatch = settings.watch<Partial<Config>>(SETTINGS_KEY, (stored) => {
      config = normalizeConfig(stored)
    })
    disposers.push(unwatch)
  }

  // ── Generation bookkeeping ────────────────────────────────────────────────
  /** Generations the host started and has not reported finished, per chat. */
  const running = new Map<string, Map<string, number>>()
  /** Automatic continues already spent on the current reply of a chat. */
  const attempts = new Map<string, { count: number; messageId?: string; at: number }>()
  let pending: { chatId: string; timer: number } | null = null

  function cancelPending(chatId?: string): void {
    if (!pending) return
    if (chatId && pending.chatId !== chatId) return
    window.clearTimeout(pending.timer)
    pending = null
  }

  function isRunning(chatId: string): boolean {
    const entries = running.get(chatId)
    if (!entries) return false
    const now = Date.now()
    for (const [id, startedAt] of entries) {
      if (now - startedAt > RUNNING_TTL_MS) entries.delete(id)
    }
    if (entries.size === 0) running.delete(chatId)
    return entries.size > 0
  }

  function markStarted(chatId: string, generationId?: string): void {
    const entries = running.get(chatId) ?? new Map<string, number>()
    entries.set(generationId ?? 'unknown', Date.now())
    running.set(chatId, entries)
  }

  /**
   * Clear the whole chat, not just this generation id. Lumiverse runs one
   * generation per chat at a time, and a terminal event for any of them means
   * the chat is idle. Deleting only the matching id meant a single missed or
   * renamed id could wedge the chat as busy forever.
   */
  function markFinished(chatId: string): void {
    running.delete(chatId)
  }

  function scheduleContinue(chatId: string, messageId: string | undefined, delayMs: number): void {
    cancelPending()
    const seconds = Math.max(1, Math.round(delayMs / 1000))
    announce(chatId, strings.waiting(seconds))
    const timer = window.setTimeout(() => {
      pending = null
      void fireContinue(chatId, messageId)
    }, delayMs)
    pending = { chatId, timer }
  }

  async function fireContinue(chatId: string, messageId: string | undefined): Promise<void> {
    if (destroyed) return
    if (!config.enabled) return skip(chatId, strings.skipped('disabled'))

    // Everything is re-checked here: the wait gave the user time to switch
    // chats, start their own reply, or close the chat entirely.
    if (ctx.getActiveChat().chatId !== chatId) return skip(chatId, strings.skipped('other-chat'))
    if (isRunning(chatId)) return skip(chatId, strings.skipped('already-generating'))

    const surfaces = ctx.host.surfaces
    if (!surfaces) return skip(chatId, strings.skipped('no-host-commands'))
    const available = surfaces
      .list(['command'])
      .some((surface) => surface.id === CONTINUE_COMMAND && surface.invocable !== false)
    if (!available) return skip(chatId, strings.skipped('continue-command-unavailable'))

    if (!claimChat(chatId)) return skip(chatId, strings.skipped('another-window-claimed-it'))

    const record_ = attempts.get(chatId) ?? { count: 0, messageId, at: Date.now() }
    record_.count += 1
    record_.messageId = messageId
    record_.at = Date.now()
    attempts.set(chatId, record_)

    announce(chatId, strings.continuing(record_.count, config.maxAttempts))
    try {
      await surfaces.invoke({ kind: 'command', id: CONTINUE_COMMAND })
    } catch (error) {
      console.warn('[lumi_autocontinue] continue failed to start', error)
      announce(chatId, strings.failed)
    }
  }

  function onGenerationEnded(raw: unknown): void {
    const payload = (raw ?? {}) as GenerationEndedLike
    const chatId = str(payload.chatId)
    if (!chatId) return
    markFinished(chatId)

    const error = str(payload.error) ?? str(payload.errorMessage)
    const truncated = !error && str(payload.finish_reason) === 'length'

    // A clean finish closes the book on this reply, and is not worth a log line.
    if (!error && !truncated) {
      attempts.delete(chatId)
      cancelPending(chatId)
      return
    }

    if (!config.enabled) return skip(chatId, strings.skipped('disabled'))
    if (truncated && !config.continueOnTruncated) return skip(chatId, strings.skipped('truncated-off'))

    // Only the two generation types that extend the tail assistant message.
    // A swipe or background swipe writes into a slot that may not be the
    // selected one, and continue would extend the wrong text.
    const generationType = str(payload.generationType) ?? 'normal'
    if (generationType !== 'normal' && generationType !== 'continue') {
      return skip(chatId, strings.skipped(`generation-type:${generationType}`))
    }

    // Nothing arrived before the socket died: there is no partial reply to
    // extend, and continuing an empty message is not what the user wants.
    const content = str(payload.content)
    if (!content || !content.trim()) return skip(chatId, strings.skipped('no-partial-text'))

    if (ctx.getActiveChat().chatId !== chatId) return skip(chatId, strings.skipped('other-chat'))
    if (isRunning(chatId)) return skip(chatId, strings.skipped('already-generating'))

    const verdict = error
      ? classifyGenerationFailure(
          { errorCode: str(payload.errorCode), error: str(payload.error), errorMessage: str(payload.errorMessage) },
          parseBlockWords(config.blockWords),
        )
      : { retry: true, slow: false, reason: 'truncated' }

    if (!verdict.retry) return skip(chatId, strings.declined(verdict.reason))

    const messageId = str(payload.messageId)
    let spentRecord = attempts.get(chatId)
    if (spentRecord && (spentRecord.messageId !== messageId || Date.now() - spentRecord.at > ATTEMPT_RESET_MS)) {
      spentRecord = undefined
      attempts.delete(chatId)
    }
    const spent = spentRecord?.count ?? 0
    if (spent >= config.maxAttempts) return announce(chatId, strings.exhausted(config.maxAttempts))

    const base = config.delaySeconds * 1000 * 2 ** spent
    const delayMs = Math.min(MAX_DELAY_MS, verdict.slow ? Math.max(base, SLOW_FLOOR_MS) : base)
    console.info(`[lumi_autocontinue] ${verdict.reason}: continuing in ${delayMs}ms`)
    scheduleContinue(chatId, messageId, delayMs)
  }

  disposers.push(
    ctx.events.on('GENERATION_STARTED', (raw) => {
      const payload = (raw ?? {}) as GenerationEndedLike
      const chatId = str(payload.chatId)
      if (!chatId) return
      markStarted(chatId, str(payload.generationId))
      // Something is generating in this chat already - ours or the user's.
      cancelPending(chatId)
    }),
  )

  disposers.push(
    ctx.events.on('GENERATION_STOPPED', (raw) => {
      const payload = (raw ?? {}) as GenerationEndedLike
      const chatId = str(payload.chatId)
      if (!chatId) return
      markFinished(chatId)
      // A stop is a decision. Do not undo it by continuing.
      cancelPending(chatId)
      attempts.delete(chatId)
    }),
  )

  disposers.push(ctx.events.on('GENERATION_ENDED', onGenerationEnded))

  disposers.push(
    ctx.events.on('CHAT_SWITCHED', () => {
      cancelPending()
    }),
  )

  // ── Settings panel ────────────────────────────────────────────────────────
  if (settings && ctx.ui.registerSettingsTab) {
    const tab = ctx.ui.registerSettingsTab({
      id: 'lumi_autocontinue',
      title: strings.settingsTitle,
      shortName: strings.settingsShort,
      description: strings.settingsDescription,
      keywords: ['continue', 'continuar', 'reconnect', 'conexao', 'retry', 'autocontinue'],
      position: 'bottom',
    })
    disposers.push(() => tab.destroy())
    const panel = buildSettingsPanel(
      ctx,
      tab.root,
      strings,
      () => config,
      (patch) => {
        config = normalizeConfig({ ...config, ...patch })
        void settings.set(SETTINGS_KEY, config).catch(() => {
          /* a failed write leaves the in-memory value in charge */
        })
      },
      () => decisions,
      ctx.manifest?.version ?? 'unknown',
    )
    renderLog = panel.renderLog
    renderLog()
    disposers.push(tab.onActivate(() => renderLog?.()))
    disposers.push(() => {
      renderLog = null
    })
  }

  if (!ctx.host.surfaces) {
    console.warn('[lumi_autocontinue] this host exposes no command surfaces; the extension cannot continue anything')
  }

  const runningVersion = ctx.manifest?.version ?? 'unknown'
  console.info(`[lumi_autocontinue] ${runningVersion} watching for dropped connections`)
  // A failed status write is itself a finding: it means the decision log will
  // not survive either, so it is reported rather than swallowed.
  void ctx.settings
    ?.set(STATUS_KEY, {
      version: runningVersion,
      startedAt: Date.now(),
      hasCommandSurfaces: !!ctx.host.surfaces,
      document: DOCUMENT_TOKEN,
    })
    .catch((error) => {
      console.warn('[lumi_autocontinue] could not persist the status beacon', error)
    })

  return () => {
    destroyed = true
    cancelPending()
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* keep tearing down */
      }
    }
    ctx.dom.cleanup()
  }
}

function buildSettingsPanel(
  ctx: SpindleFrontendContext,
  root: HTMLElement,
  strings: Strings,
  read: () => Config,
  write: (patch: Partial<Config>) => void,
  readDecisions: () => readonly Decision[],
  runningVersion: string,
): { renderLog: () => void } {
  const panel = ctx.dom.createElement('div', { class: 'lac-settings' })
  root.appendChild(panel)

  const row = (label: string, help: string): HTMLElement => {
    const wrapper = ctx.dom.createElement('div', { class: 'lac-row' })
    const main = ctx.dom.createElement('div', { class: 'lac-row-main' })
    const title = ctx.dom.createElement('span', { class: 'lac-label' })
    title.textContent = label
    const hint = ctx.dom.createElement('p', { class: 'lac-help' })
    hint.textContent = help
    main.appendChild(title)
    main.appendChild(hint)
    const control = ctx.dom.createElement('div', { class: 'lac-control' })
    wrapper.appendChild(main)
    wrapper.appendChild(control)
    panel.appendChild(wrapper)
    return control
  }

  const current = read()

  ctx.components.mountSwitch(row(strings.enabledLabel, strings.enabledHelp), {
    checked: current.enabled,
    ariaLabel: strings.enabledLabel,
    onChange: (checked) => write({ enabled: checked }),
  })

  ctx.components.mountNumericInput(row(strings.attemptsLabel, strings.attemptsHelp), {
    value: current.maxAttempts,
    integer: true,
    min: 1,
    max: 5,
    step: 1,
    ariaLabel: strings.attemptsLabel,
    onChange: (value) => write({ maxAttempts: value ?? DEFAULTS.maxAttempts }),
  })

  ctx.components.mountNumericInput(row(strings.delayLabel, strings.delayHelp), {
    value: current.delaySeconds,
    integer: true,
    min: 1,
    max: 120,
    step: 1,
    ariaLabel: strings.delayLabel,
    onChange: (value) => write({ delaySeconds: value ?? DEFAULTS.delaySeconds }),
  })

  ctx.components.mountSwitch(row(strings.truncatedLabel, strings.truncatedHelp), {
    checked: current.continueOnTruncated,
    ariaLabel: strings.truncatedLabel,
    onChange: (checked) => write({ continueOnTruncated: checked }),
  })

  ctx.components.mountSwitch(row(strings.announceLabel, strings.announceHelp), {
    checked: current.announce,
    ariaLabel: strings.announceLabel,
    onChange: (checked) => write({ announce: checked }),
  })

  const blockSection = ctx.dom.createElement('div', { class: 'lac-block' })
  const blockLabel = ctx.dom.createElement('span', { class: 'lac-label' })
  blockLabel.textContent = strings.blockLabel
  const blockHelp = ctx.dom.createElement('p', { class: 'lac-help' })
  blockHelp.textContent = strings.blockHelp
  const blockControl = ctx.dom.createElement('div')
  blockSection.appendChild(blockLabel)
  blockSection.appendChild(blockHelp)
  blockSection.appendChild(blockControl)
  panel.appendChild(blockSection)

  ctx.components.mountTextArea(blockControl, {
    value: current.blockWords,
    rows: 3,
    placeholder: strings.blockPlaceholder,
    ariaLabel: strings.blockLabel,
    onChange: (value) => write({ blockWords: value }),
  })

  // Decision log: the answer to "why did nothing happen?", readable without
  // opening developer tools.
  const logBox = ctx.dom.createElement('div', { class: 'lac-logbox' })
  const logTitle = ctx.dom.createElement('div', { class: 'lac-policy-title' })
  logTitle.textContent = strings.logTitle
  const logHelp = ctx.dom.createElement('p', { class: 'lac-help' })
  logHelp.textContent = strings.logHelp
  // The version of the code actually running in this page, which can lag the
  // version on the extension card until the page is reloaded.
  const logVersion = ctx.dom.createElement('p', { class: 'lac-help' })
  logVersion.textContent = strings.runningVersion(runningVersion)
  const logList = ctx.dom.createElement('ul', { class: 'lac-log' })
  logBox.appendChild(logTitle)
  logBox.appendChild(logHelp)
  logBox.appendChild(logVersion)
  logBox.appendChild(logList)
  panel.appendChild(logBox)

  const renderLog = (): void => {
    const entries = readDecisions()
    logList.textContent = ''
    if (entries.length === 0) {
      const empty = ctx.dom.createElement('li')
      empty.textContent = strings.logEmpty
      logList.appendChild(empty)
      return
    }
    for (const entry of entries) {
      const item = ctx.dom.createElement('li')
      let stamp: string
      try {
        stamp = new Date(entry.at).toLocaleTimeString()
      } catch {
        stamp = ''
      }
      item.textContent = stamp ? `${stamp} — ${entry.text}` : entry.text
      logList.appendChild(item)
    }
  }

  const policy = ctx.dom.createElement('div', { class: 'lac-policy' })
  const policyTitle = ctx.dom.createElement('div', { class: 'lac-policy-title' })
  policyTitle.textContent = strings.policyTitle
  const policyBody = ctx.dom.createElement('p', { class: 'lac-help' })
  policyBody.textContent = strings.policyBody
  policy.appendChild(policyTitle)
  policy.appendChild(policyBody)
  panel.appendChild(policy)

  return { renderLog }
}
