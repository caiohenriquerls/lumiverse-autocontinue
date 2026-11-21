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
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { classifyGenerationFailure } from './error-policy'
import { pickStrings, type Strings } from './strings'

const SETTINGS_KEY = 'config'
const CONTINUE_COMMAND = 'action-continue'
const CLAIM_PREFIX = 'spindle:lumi_autocontinue:claim:'
/** How long one tab's claim on a chat blocks the other tabs. */
const CLAIM_TTL_MS = 15_000
/** Rate-limit failures never retry sooner than this. */
const SLOW_FLOOR_MS = 20_000
const MAX_DELAY_MS = 120_000
/** A new failure this long after the last one starts the attempt count over. */
const ATTEMPT_RESET_MS = 10 * 60_000
const NOTICE_TTL_MS = 7_000

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

/**
 * Best-effort cross-tab lock. Two tabs open on the same chat both receive
 * GENERATION_ENDED, and two continues would produce two generations. Session
 * matching already settles the usual case; this covers the rest. Storage being
 * unavailable must never disable the feature, so a failure claims the slot.
 */
function claimChat(chatId: string): boolean {
  const key = `${CLAIM_PREFIX}${chatId}`
  try {
    const now = Date.now()
    const existing = window.localStorage.getItem(key)
    if (existing) {
      const parsed = JSON.parse(existing) as { at?: unknown }
      if (typeof parsed?.at === 'number' && now - parsed.at < CLAIM_TTL_MS) return false
    }
    const token = `${now}-${Math.random().toString(36).slice(2)}`
    window.localStorage.setItem(key, JSON.stringify({ at: now, token }))
    const readBack = window.localStorage.getItem(key)
    if (!readBack) return true
    return (JSON.parse(readBack) as { token?: unknown })?.token === token
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
    .lac-policy {
      padding: 12px 14px;
      border: 1px solid var(--lumiverse-border, rgba(127,127,127,.4));
      border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-fill-subtle, transparent);
    }
    .lac-policy-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
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

  function announce(text: string): void {
    if (destroyed) return
    console.info(`[lumi_autocontinue] ${text}`)
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
    const unwatch = settings.watch<Partial<Config>>(SETTINGS_KEY, (stored) => {
      config = normalizeConfig(stored)
    })
    disposers.push(unwatch)
  }

  // ── Generation bookkeeping ────────────────────────────────────────────────
  /** Generations the host has started and not yet finished, per chat. */
  const running = new Map<string, Set<string>>()
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
    const set = running.get(chatId)
    return !!set && set.size > 0
  }

  function markStarted(chatId: string, generationId?: string): void {
    const set = running.get(chatId) ?? new Set<string>()
    set.add(generationId ?? 'unknown')
    running.set(chatId, set)
  }

  function markFinished(chatId: string, generationId?: string): void {
    const set = running.get(chatId)
    if (!set) return
    set.delete(generationId ?? 'unknown')
    if (set.size === 0) running.delete(chatId)
  }

  /**
   * Only the tab that started the generation may continue it. The host stamps
   * the originating document on the payload; when it is missing (older hosts,
   * generations started outside a browser) fall back to the visible tab plus
   * the cross-tab claim taken at fire time.
   */
  function ownsGeneration(payload: GenerationEndedLike): boolean {
    const owner = str(payload.frontendSessionId)
    const mine = typeof ctx.frontendSessionId === 'string' ? ctx.frontendSessionId : undefined
    if (owner && mine) return owner === mine
    try {
      return document.visibilityState === 'visible'
    } catch {
      return true
    }
  }

  function scheduleContinue(chatId: string, messageId: string | undefined, delayMs: number): void {
    cancelPending()
    const seconds = Math.max(1, Math.round(delayMs / 1000))
    announce(strings.waiting(seconds))
    const timer = window.setTimeout(() => {
      pending = null
      void fireContinue(chatId, messageId)
    }, delayMs)
    pending = { chatId, timer }
  }

  async function fireContinue(chatId: string, messageId: string | undefined): Promise<void> {
    if (destroyed || !config.enabled) return

    // Everything is re-checked here: the wait gave the user time to switch
    // chats, start their own reply, or close the chat entirely.
    if (ctx.getActiveChat().chatId !== chatId) return
    if (isRunning(chatId)) return

    const surfaces = ctx.host.surfaces
    if (!surfaces) return
    const available = surfaces
      .list(['command'])
      .some((surface) => surface.id === CONTINUE_COMMAND && surface.invocable !== false)
    if (!available) {
      console.warn('[lumi_autocontinue] the host does not expose action-continue to this extension')
      return
    }

    if (!claimChat(chatId)) return

    const record = attempts.get(chatId) ?? { count: 0, messageId, at: Date.now() }
    record.count += 1
    record.messageId = messageId
    record.at = Date.now()
    attempts.set(chatId, record)

    announce(strings.continuing(record.count, config.maxAttempts))
    try {
      await surfaces.invoke({ kind: 'command', id: CONTINUE_COMMAND })
    } catch (error) {
      console.warn('[lumi_autocontinue] continue failed to start', error)
      announce(strings.failed)
    }
  }

  function onGenerationEnded(raw: unknown): void {
    const payload = (raw ?? {}) as GenerationEndedLike
    const chatId = str(payload.chatId)
    const generationId = str(payload.generationId)
    if (!chatId) return
    markFinished(chatId, generationId)

    if (!config.enabled) return

    const error = str(payload.error) ?? str(payload.errorMessage)
    const truncated = !error && str(payload.finish_reason) === 'length'

    // A clean finish closes the book on this reply.
    if (!error && !truncated) {
      attempts.delete(chatId)
      cancelPending(chatId)
      return
    }
    if (truncated && !config.continueOnTruncated) return

    // Only the two generation types that extend the tail assistant message.
    // A swipe or background swipe writes into a slot that may not be the
    // selected one, and continue would extend the wrong text.
    const generationType = str(payload.generationType) ?? 'normal'
    if (generationType !== 'normal' && generationType !== 'continue') return

    // Nothing arrived before the socket died: there is no partial reply to
    // extend, and continuing an empty message is not what the user wants.
    const content = str(payload.content)
    if (!content || !content.trim()) return

    if (!ownsGeneration(payload)) return
    if (ctx.getActiveChat().chatId !== chatId) return
    if (isRunning(chatId)) return

    const verdict = error
      ? classifyGenerationFailure(
          { errorCode: str(payload.errorCode), error: str(payload.error), errorMessage: str(payload.errorMessage) },
          parseBlockWords(config.blockWords),
        )
      : { retry: true, slow: false, reason: 'truncated' }

    if (!verdict.retry) {
      console.info(`[lumi_autocontinue] leaving this one alone (${verdict.reason})`)
      return
    }

    const messageId = str(payload.messageId)
    let record = attempts.get(chatId)
    if (record && (record.messageId !== messageId || Date.now() - record.at > ATTEMPT_RESET_MS)) {
      record = undefined
      attempts.delete(chatId)
    }
    const spent = record?.count ?? 0
    if (spent >= config.maxAttempts) {
      announce(strings.exhausted(config.maxAttempts))
      return
    }

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
      markFinished(chatId, str(payload.generationId))
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
    buildSettingsPanel(ctx, tab.root, strings, () => config, (patch) => {
      config = normalizeConfig({ ...config, ...patch })
      void settings.set(SETTINGS_KEY, config).catch(() => {
        /* a failed write leaves the in-memory value in charge */
      })
    })
  }

  if (!ctx.host.surfaces) {
    console.warn('[lumi_autocontinue] this host exposes no command surfaces; the extension cannot continue anything')
  }

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
): void {
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

  const policy = ctx.dom.createElement('div', { class: 'lac-policy' })
  const policyTitle = ctx.dom.createElement('div', { class: 'lac-policy-title' })
  policyTitle.textContent = strings.policyTitle
  const policyBody = ctx.dom.createElement('p', { class: 'lac-help' })
  policyBody.textContent = strings.policyBody
  policy.appendChild(policyTitle)
  policy.appendChild(policyBody)
  panel.appendChild(policy)
}
