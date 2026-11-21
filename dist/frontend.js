// src/error-policy.ts
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function extractStatus(rawCode, rawMessage) {
  const fromCode = /\bhttp (\d{3})\b/.exec(normalize(rawCode));
  if (fromCode && fromCode[1])
    return Number(fromCode[1]);
  const fromMessage = /\((\d{3})\)/.exec(rawMessage);
  if (fromMessage && fromMessage[1])
    return Number(fromMessage[1]);
  return null;
}
var DENY_STATUS = new Set([400, 401, 402, 403, 404, 405, 406, 407, 409, 410, 413, 414, 415, 422, 451]);
var ALLOW_STATUS = new Set([408, 425, 500, 502, 503, 504, 507, 508, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
var SLOW_STATUS = new Set([429]);
var DENY_PATTERNS = [
  "payment",
  "billing",
  "insufficient",
  "quota",
  "credit",
  "balance",
  "funds",
  "invoice",
  "subscription",
  "upgrade",
  "free tier",
  "spending limit",
  "hard limit",
  "usage limit",
  "top up",
  "topup",
  "prepaid",
  "pagamento",
  "saldo",
  "cobran",
  "assinatura",
  "fatura",
  "api key",
  "apikey",
  "unauthorized",
  "unauthenticated",
  "authentication",
  "authorization",
  "invalid key",
  "invalid token",
  "expired",
  "forbidden",
  "permission",
  "not allowed",
  "access denied",
  "suspended",
  "deactivated",
  "banned",
  "no stored key",
  "sign in",
  "login",
  "nao autorizado",
  "chave invalida",
  "credencia",
  "moderation",
  "content policy",
  "content filter",
  "safety",
  "prohibited",
  "violat",
  "flagged",
  "blocked",
  "refused to",
  "bad request",
  "invalid request",
  "unprocessable",
  "validation",
  "context length",
  "context window",
  "maximum context",
  "too many tokens",
  "token limit",
  "max tokens",
  "model not found",
  "unknown model",
  "invalid model",
  "no such model",
  "does not exist",
  "unsupported",
  "not supported",
  "deprecated",
  "invalid parameter",
  "not found",
  "abort",
  "cancel",
  "stopped by",
  "no activity for",
  "unavailable in your",
  "not available in",
  "region"
];
var DENY_CODES = ["generation timeout", "abort error", "aborterror"];
var ALLOW_PATTERNS = [
  "econnreset",
  "econnaborted",
  "econnrefused",
  "etimedout",
  "epipe",
  "enetunreach",
  "enetdown",
  "ehostunreach",
  "enotfound",
  "eai again",
  "und err",
  "connectionclosed",
  "connectionrefused",
  "failedtoopensocket",
  "failed to open socket",
  "socket hang up",
  "socket closed",
  "socket error",
  "connection closed",
  "connection reset",
  "connection error",
  "connection lost",
  "connection terminated",
  "terminated",
  "premature close",
  "stream closed",
  "stream ended",
  "unexpected end",
  "incomplete",
  "fetch failed",
  "failed to fetch",
  "network",
  "offline",
  "dns",
  "tls",
  "handshake",
  "conexao",
  "rede",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "request timeout",
  "timed out",
  "timeout",
  "upstream",
  "internal server error",
  "server error",
  "temporarily",
  "try again"
];
var SLOW_PATTERNS = [
  "rate limit",
  "ratelimit",
  "too many requests",
  "overloaded",
  "capacity",
  "congest",
  "retry after",
  "try again later",
  "slow down"
];
function hits(haystack, patterns) {
  for (const pattern of patterns) {
    if (pattern && haystack.includes(pattern))
      return pattern;
  }
  return null;
}
function classifyGenerationFailure(input, extraBlocked = []) {
  const rawCode = input.errorCode ?? "";
  const rawMessage = `${input.error ?? ""} ${input.errorMessage ?? ""}`;
  const code = normalize(rawCode);
  const text = normalize(`${rawCode} ${rawMessage}`);
  if (!text)
    return { retry: false, slow: false, reason: "no-error-text" };
  const custom = hits(text, extraBlocked.map(normalize).filter(Boolean));
  if (custom)
    return { retry: false, slow: false, reason: `blocked-by-user:${custom}` };
  const deniedCode = hits(code, DENY_CODES);
  if (deniedCode)
    return { retry: false, slow: false, reason: `permanent-code:${deniedCode}` };
  const denied = hits(text, DENY_PATTERNS);
  if (denied)
    return { retry: false, slow: false, reason: `permanent:${denied}` };
  const status = extractStatus(rawCode, rawMessage);
  if (status !== null && DENY_STATUS.has(status)) {
    return { retry: false, slow: false, reason: `permanent-status:${status}` };
  }
  if (status !== null && SLOW_STATUS.has(status)) {
    return { retry: true, slow: true, reason: `throttled-status:${status}` };
  }
  const slow = hits(text, SLOW_PATTERNS);
  if (slow)
    return { retry: true, slow: true, reason: `throttled:${slow}` };
  if (status !== null && ALLOW_STATUS.has(status)) {
    return { retry: true, slow: false, reason: `transient-status:${status}` };
  }
  const allowed = hits(text, ALLOW_PATTERNS);
  if (allowed)
    return { retry: true, slow: false, reason: `transient:${allowed}` };
  return { retry: false, slow: false, reason: "unrecognised" };
}

// src/strings.ts
var EN = {
  settingsTitle: "Auto-Continue",
  settingsShort: "Continue",
  settingsDescription: "Re-fire Continue when a reply dies from a dropped connection",
  enabledLabel: "Auto-continue after a dropped connection",
  enabledHelp: "When a reply stops mid-stream because the connection to the provider broke, send Continue by itself so the message picks up where it stopped.",
  attemptsLabel: "Maximum attempts per message",
  attemptsHelp: "After this many automatic continues on the same reply, it stops and leaves the message to you.",
  delayLabel: "Wait before continuing (seconds)",
  delayHelp: "The pause doubles on each further attempt. Rate-limit failures always wait at least 20 seconds.",
  truncatedLabel: "Also continue a reply cut off by the token limit",
  truncatedHelp: "No error happened: the model simply hit its output limit. Off by default, because a long reply can then grow on its own.",
  announceLabel: "Announce what it is doing",
  announceHelp: "Shows a short status line, readable by a screen reader, each time it waits, continues or declines.",
  blockLabel: "Never continue when the error mentions",
  blockHelp: "One word or phrase per line. Checked before every built-in rule.",
  blockPlaceholder: `trial
my gateway`,
  policyTitle: "What it never retries",
  policyBody: "Payment, credit, quota and plan limits; invalid or missing API keys and every other credential failure; moderation and content policy; context length, unknown models and malformed requests; a generation you stopped yourself. An error it does not recognise is left alone too.",
  logTitle: "Recent decisions",
  logHelp: "Newest first. Every failure it could have continued leaves a line here, including the ones it chose not to continue.",
  logEmpty: "Nothing recorded yet — no generation has failed since this page loaded.",
  declined: (reason) => `Did not continue: ${reason}.`,
  skipped: (guard) => `Did not continue, guard: ${guard}.`,
  waiting: (seconds) => `Connection lost. Continuing in ${seconds}s...`,
  continuing: (attempt, max) => `Continuing the reply (attempt ${attempt} of ${max}).`,
  exhausted: (max) => `Stopped after ${max} automatic continues. Over to you.`,
  failed: "The automatic continue could not start."
};
var PT = {
  settingsTitle: "Continuar automático",
  settingsShort: "Continuar",
  settingsDescription: "Manda Continue de novo quando a resposta morre por queda de conexão",
  enabledLabel: "Continuar sozinho depois de queda de conexão",
  enabledHelp: "Quando a resposta para no meio porque a conexão com o provedor caiu, manda o Continue por conta própria para a mensagem seguir de onde parou.",
  attemptsLabel: "Máximo de tentativas por mensagem",
  attemptsHelp: "Depois dessa quantidade de continues automáticos na mesma resposta, ele desiste e deixa a mensagem para você.",
  delayLabel: "Esperar antes de continuar (segundos)",
  delayHelp: "A pausa dobra em cada tentativa seguinte. Erro de limite de uso espera no mínimo 20 segundos.",
  truncatedLabel: "Continuar também quando o limite de tokens cortar a resposta",
  truncatedHelp: "Não houve erro: o modelo só bateu no limite de saída. Desligado por padrão, porque assim uma resposta longa pode crescer sozinha.",
  announceLabel: "Anunciar o que está fazendo",
  announceHelp: "Mostra uma linha de status curta, lida por leitor de tela, cada vez que ele espera, continua ou recusa.",
  blockLabel: "Nunca continuar quando o erro mencionar",
  blockHelp: "Uma palavra ou frase por linha. Verificado antes de qualquer regra interna.",
  blockPlaceholder: `teste
meu gateway`,
  policyTitle: "O que ele nunca repete",
  policyBody: "Pagamento, crédito, cota e limite de plano; chave de API inválida ou ausente e qualquer outra falha de credencial; moderação e política de conteúdo; tamanho de contexto, modelo desconhecido e requisição malformada; geração que você mesmo parou. Erro que ele não reconhece também fica quieto.",
  logTitle: "Decisões recentes",
  logHelp: "Mais recente primeiro. Toda falha que ele poderia ter continuado deixa uma linha aqui, inclusive as que ele escolheu não continuar.",
  logEmpty: "Nada registrado ainda — nenhuma geração falhou desde que esta página carregou.",
  declined: (reason) => `Não continuei: ${reason}.`,
  skipped: (guard) => `Não continuei, trava: ${guard}.`,
  waiting: (seconds) => `Conexão caiu. Continuando em ${seconds}s...`,
  continuing: (attempt, max) => `Continuando a resposta (tentativa ${attempt} de ${max}).`,
  exhausted: (max) => `Parei depois de ${max} continues automáticos. A bola está com você.`,
  failed: "O continue automático não conseguiu começar."
};
function pickStrings() {
  try {
    const languages = [navigator.language, ...navigator.languages ?? []];
    if (languages.some((tag) => typeof tag === "string" && tag.toLowerCase().startsWith("pt")))
      return PT;
  } catch {}
  return EN;
}

// src/frontend.ts
var SETTINGS_KEY = "config";
var DECISIONS_KEY = "decisions";
var CONTINUE_COMMAND = "action-continue";
var CLAIM_PREFIX = "spindle:lumi_autocontinue:claim:";
var CLAIM_TTL_MS = 15000;
var SLOW_FLOOR_MS = 20000;
var MAX_DELAY_MS = 120000;
var ATTEMPT_RESET_MS = 10 * 60000;
var RUNNING_TTL_MS = 15 * 60000;
var NOTICE_TTL_MS = 7000;
var MAX_DECISIONS = 20;
var DEFAULTS = {
  enabled: true,
  maxAttempts: 2,
  delaySeconds: 3,
  continueOnTruncated: false,
  announce: true,
  blockWords: ""
};
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function clamp(value, min, max, fallback) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(numeric))
    return fallback;
  return Math.min(max, Math.max(min, numeric));
}
function normalizeConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULTS.enabled,
    maxAttempts: clamp(input.maxAttempts, 1, 5, DEFAULTS.maxAttempts),
    delaySeconds: clamp(input.delaySeconds, 1, 120, DEFAULTS.delaySeconds),
    continueOnTruncated: typeof input.continueOnTruncated === "boolean" ? input.continueOnTruncated : DEFAULTS.continueOnTruncated,
    announce: typeof input.announce === "boolean" ? input.announce : DEFAULTS.announce,
    blockWords: typeof input.blockWords === "string" ? input.blockWords : DEFAULTS.blockWords
  };
}
function parseBlockWords(text) {
  return text.split(/[\n,;]+/).map((word) => word.trim()).filter((word) => word.length >= 3);
}
var DOCUMENT_TOKEN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function claimChat(chatId) {
  const key = `${CLAIM_PREFIX}${chatId}`;
  try {
    const now = Date.now();
    const existing = window.localStorage.getItem(key);
    if (existing) {
      const parsed = JSON.parse(existing);
      const fresh = typeof parsed?.at === "number" && now - parsed.at < CLAIM_TTL_MS;
      if (fresh && parsed?.token !== DOCUMENT_TOKEN)
        return false;
    }
    window.localStorage.setItem(key, JSON.stringify({ at: now, token: DOCUMENT_TOKEN }));
    const readBack = window.localStorage.getItem(key);
    if (!readBack)
      return true;
    return JSON.parse(readBack)?.token === DOCUMENT_TOKEN;
  } catch {
    return true;
  }
}
function setup(ctx) {
  const strings = pickStrings();
  const disposers = [];
  let config = { ...DEFAULTS };
  let destroyed = false;
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
  `);
  disposers.push(removeStyle);
  const noticeWrapper = ctx.dom.inject("body", '<div class="lac-notice" role="status" aria-live="polite" aria-atomic="true"></div>');
  const notice = noticeWrapper.querySelector(".lac-notice") ?? noticeWrapper;
  let noticeTimer = null;
  let decisions = [];
  let renderLog = null;
  function record(chatId, text) {
    decisions = [{ at: Date.now(), chatId, text }, ...decisions].slice(0, MAX_DECISIONS);
    renderLog?.();
    ctx.settings?.set(DECISIONS_KEY, decisions).catch(() => {});
  }
  function announce(chatId, text) {
    if (destroyed)
      return;
    console.info(`[lumi_autocontinue] ${text}`);
    record(chatId, text);
    if (!config.announce)
      return;
    notice.textContent = text;
    notice.setAttribute("data-visible", "true");
    if (noticeTimer !== null)
      window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      noticeTimer = null;
      notice.setAttribute("data-visible", "false");
      notice.textContent = "";
    }, NOTICE_TTL_MS);
  }
  function skip(chatId, text) {
    console.info(`[lumi_autocontinue] ${text}`);
    record(chatId, text);
  }
  disposers.push(() => {
    if (noticeTimer !== null)
      window.clearTimeout(noticeTimer);
    ctx.dom.uninject(noticeWrapper);
  });
  const settings = ctx.settings;
  if (settings) {
    settings.get(SETTINGS_KEY).then((stored) => {
      if (!destroyed && stored !== undefined)
        config = normalizeConfig(stored);
    }).catch(() => {});
    settings.get(DECISIONS_KEY).then((stored) => {
      if (destroyed || !Array.isArray(stored))
        return;
      const restored = stored.filter((entry) => !!entry && typeof entry.at === "number" && typeof entry.text === "string");
      decisions = [...decisions, ...restored].slice(0, MAX_DECISIONS);
      renderLog?.();
    }).catch(() => {});
    const unwatch = settings.watch(SETTINGS_KEY, (stored) => {
      config = normalizeConfig(stored);
    });
    disposers.push(unwatch);
  }
  const running = new Map;
  const attempts = new Map;
  let pending = null;
  function cancelPending(chatId) {
    if (!pending)
      return;
    if (chatId && pending.chatId !== chatId)
      return;
    window.clearTimeout(pending.timer);
    pending = null;
  }
  function isRunning(chatId) {
    const entries = running.get(chatId);
    if (!entries)
      return false;
    const now = Date.now();
    for (const [id, startedAt] of entries) {
      if (now - startedAt > RUNNING_TTL_MS)
        entries.delete(id);
    }
    if (entries.size === 0)
      running.delete(chatId);
    return entries.size > 0;
  }
  function markStarted(chatId, generationId) {
    const entries = running.get(chatId) ?? new Map;
    entries.set(generationId ?? "unknown", Date.now());
    running.set(chatId, entries);
  }
  function markFinished(chatId) {
    running.delete(chatId);
  }
  function scheduleContinue(chatId, messageId, delayMs) {
    cancelPending();
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    announce(chatId, strings.waiting(seconds));
    const timer = window.setTimeout(() => {
      pending = null;
      fireContinue(chatId, messageId);
    }, delayMs);
    pending = { chatId, timer };
  }
  async function fireContinue(chatId, messageId) {
    if (destroyed)
      return;
    if (!config.enabled)
      return skip(chatId, strings.skipped("disabled"));
    if (ctx.getActiveChat().chatId !== chatId)
      return skip(chatId, strings.skipped("other-chat"));
    if (isRunning(chatId))
      return skip(chatId, strings.skipped("already-generating"));
    const surfaces = ctx.host.surfaces;
    if (!surfaces)
      return skip(chatId, strings.skipped("no-host-commands"));
    const available = surfaces.list(["command"]).some((surface) => surface.id === CONTINUE_COMMAND && surface.invocable !== false);
    if (!available)
      return skip(chatId, strings.skipped("continue-command-unavailable"));
    if (!claimChat(chatId))
      return skip(chatId, strings.skipped("another-window-claimed-it"));
    const record_ = attempts.get(chatId) ?? { count: 0, messageId, at: Date.now() };
    record_.count += 1;
    record_.messageId = messageId;
    record_.at = Date.now();
    attempts.set(chatId, record_);
    announce(chatId, strings.continuing(record_.count, config.maxAttempts));
    try {
      await surfaces.invoke({ kind: "command", id: CONTINUE_COMMAND });
    } catch (error) {
      console.warn("[lumi_autocontinue] continue failed to start", error);
      announce(chatId, strings.failed);
    }
  }
  function onGenerationEnded(raw) {
    const payload = raw ?? {};
    const chatId = str(payload.chatId);
    if (!chatId)
      return;
    markFinished(chatId);
    const error = str(payload.error) ?? str(payload.errorMessage);
    const truncated = !error && str(payload.finish_reason) === "length";
    if (!error && !truncated) {
      attempts.delete(chatId);
      cancelPending(chatId);
      return;
    }
    if (!config.enabled)
      return skip(chatId, strings.skipped("disabled"));
    if (truncated && !config.continueOnTruncated)
      return skip(chatId, strings.skipped("truncated-off"));
    const generationType = str(payload.generationType) ?? "normal";
    if (generationType !== "normal" && generationType !== "continue") {
      return skip(chatId, strings.skipped(`generation-type:${generationType}`));
    }
    const content = str(payload.content);
    if (!content || !content.trim())
      return skip(chatId, strings.skipped("no-partial-text"));
    if (ctx.getActiveChat().chatId !== chatId)
      return skip(chatId, strings.skipped("other-chat"));
    if (isRunning(chatId))
      return skip(chatId, strings.skipped("already-generating"));
    const verdict = error ? classifyGenerationFailure({ errorCode: str(payload.errorCode), error: str(payload.error), errorMessage: str(payload.errorMessage) }, parseBlockWords(config.blockWords)) : { retry: true, slow: false, reason: "truncated" };
    if (!verdict.retry)
      return skip(chatId, strings.declined(verdict.reason));
    const messageId = str(payload.messageId);
    let spentRecord = attempts.get(chatId);
    if (spentRecord && (spentRecord.messageId !== messageId || Date.now() - spentRecord.at > ATTEMPT_RESET_MS)) {
      spentRecord = undefined;
      attempts.delete(chatId);
    }
    const spent = spentRecord?.count ?? 0;
    if (spent >= config.maxAttempts)
      return announce(chatId, strings.exhausted(config.maxAttempts));
    const base = config.delaySeconds * 1000 * 2 ** spent;
    const delayMs = Math.min(MAX_DELAY_MS, verdict.slow ? Math.max(base, SLOW_FLOOR_MS) : base);
    console.info(`[lumi_autocontinue] ${verdict.reason}: continuing in ${delayMs}ms`);
    scheduleContinue(chatId, messageId, delayMs);
  }
  disposers.push(ctx.events.on("GENERATION_STARTED", (raw) => {
    const payload = raw ?? {};
    const chatId = str(payload.chatId);
    if (!chatId)
      return;
    markStarted(chatId, str(payload.generationId));
    cancelPending(chatId);
  }));
  disposers.push(ctx.events.on("GENERATION_STOPPED", (raw) => {
    const payload = raw ?? {};
    const chatId = str(payload.chatId);
    if (!chatId)
      return;
    markFinished(chatId);
    cancelPending(chatId);
    attempts.delete(chatId);
  }));
  disposers.push(ctx.events.on("GENERATION_ENDED", onGenerationEnded));
  disposers.push(ctx.events.on("CHAT_SWITCHED", () => {
    cancelPending();
  }));
  if (settings && ctx.ui.registerSettingsTab) {
    const tab = ctx.ui.registerSettingsTab({
      id: "lumi_autocontinue",
      title: strings.settingsTitle,
      shortName: strings.settingsShort,
      description: strings.settingsDescription,
      keywords: ["continue", "continuar", "reconnect", "conexao", "retry", "autocontinue"],
      position: "bottom"
    });
    disposers.push(() => tab.destroy());
    const panel = buildSettingsPanel(ctx, tab.root, strings, () => config, (patch) => {
      config = normalizeConfig({ ...config, ...patch });
      settings.set(SETTINGS_KEY, config).catch(() => {});
    }, () => decisions);
    renderLog = panel.renderLog;
    renderLog();
    disposers.push(tab.onActivate(() => renderLog?.()));
    disposers.push(() => {
      renderLog = null;
    });
  }
  if (!ctx.host.surfaces) {
    console.warn("[lumi_autocontinue] this host exposes no command surfaces; the extension cannot continue anything");
  }
  console.info("[lumi_autocontinue] watching for dropped connections");
  return () => {
    destroyed = true;
    cancelPending();
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {}
    }
    ctx.dom.cleanup();
  };
}
function buildSettingsPanel(ctx, root, strings, read, write, readDecisions) {
  const panel = ctx.dom.createElement("div", { class: "lac-settings" });
  root.appendChild(panel);
  const row = (label, help) => {
    const wrapper = ctx.dom.createElement("div", { class: "lac-row" });
    const main = ctx.dom.createElement("div", { class: "lac-row-main" });
    const title = ctx.dom.createElement("span", { class: "lac-label" });
    title.textContent = label;
    const hint = ctx.dom.createElement("p", { class: "lac-help" });
    hint.textContent = help;
    main.appendChild(title);
    main.appendChild(hint);
    const control = ctx.dom.createElement("div", { class: "lac-control" });
    wrapper.appendChild(main);
    wrapper.appendChild(control);
    panel.appendChild(wrapper);
    return control;
  };
  const current = read();
  ctx.components.mountSwitch(row(strings.enabledLabel, strings.enabledHelp), {
    checked: current.enabled,
    ariaLabel: strings.enabledLabel,
    onChange: (checked) => write({ enabled: checked })
  });
  ctx.components.mountNumericInput(row(strings.attemptsLabel, strings.attemptsHelp), {
    value: current.maxAttempts,
    integer: true,
    min: 1,
    max: 5,
    step: 1,
    ariaLabel: strings.attemptsLabel,
    onChange: (value) => write({ maxAttempts: value ?? DEFAULTS.maxAttempts })
  });
  ctx.components.mountNumericInput(row(strings.delayLabel, strings.delayHelp), {
    value: current.delaySeconds,
    integer: true,
    min: 1,
    max: 120,
    step: 1,
    ariaLabel: strings.delayLabel,
    onChange: (value) => write({ delaySeconds: value ?? DEFAULTS.delaySeconds })
  });
  ctx.components.mountSwitch(row(strings.truncatedLabel, strings.truncatedHelp), {
    checked: current.continueOnTruncated,
    ariaLabel: strings.truncatedLabel,
    onChange: (checked) => write({ continueOnTruncated: checked })
  });
  ctx.components.mountSwitch(row(strings.announceLabel, strings.announceHelp), {
    checked: current.announce,
    ariaLabel: strings.announceLabel,
    onChange: (checked) => write({ announce: checked })
  });
  const blockSection = ctx.dom.createElement("div", { class: "lac-block" });
  const blockLabel = ctx.dom.createElement("span", { class: "lac-label" });
  blockLabel.textContent = strings.blockLabel;
  const blockHelp = ctx.dom.createElement("p", { class: "lac-help" });
  blockHelp.textContent = strings.blockHelp;
  const blockControl = ctx.dom.createElement("div");
  blockSection.appendChild(blockLabel);
  blockSection.appendChild(blockHelp);
  blockSection.appendChild(blockControl);
  panel.appendChild(blockSection);
  ctx.components.mountTextArea(blockControl, {
    value: current.blockWords,
    rows: 3,
    placeholder: strings.blockPlaceholder,
    ariaLabel: strings.blockLabel,
    onChange: (value) => write({ blockWords: value })
  });
  const logBox = ctx.dom.createElement("div", { class: "lac-logbox" });
  const logTitle = ctx.dom.createElement("div", { class: "lac-policy-title" });
  logTitle.textContent = strings.logTitle;
  const logHelp = ctx.dom.createElement("p", { class: "lac-help" });
  logHelp.textContent = strings.logHelp;
  const logList = ctx.dom.createElement("ul", { class: "lac-log" });
  logBox.appendChild(logTitle);
  logBox.appendChild(logHelp);
  logBox.appendChild(logList);
  panel.appendChild(logBox);
  const renderLog = () => {
    const entries = readDecisions();
    logList.textContent = "";
    if (entries.length === 0) {
      const empty = ctx.dom.createElement("li");
      empty.textContent = strings.logEmpty;
      logList.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const item = ctx.dom.createElement("li");
      let stamp;
      try {
        stamp = new Date(entry.at).toLocaleTimeString();
      } catch {
        stamp = "";
      }
      item.textContent = stamp ? `${stamp} — ${entry.text}` : entry.text;
      logList.appendChild(item);
    }
  };
  const policy = ctx.dom.createElement("div", { class: "lac-policy" });
  const policyTitle = ctx.dom.createElement("div", { class: "lac-policy-title" });
  policyTitle.textContent = strings.policyTitle;
  const policyBody = ctx.dom.createElement("p", { class: "lac-help" });
  policyBody.textContent = strings.policyBody;
  policy.appendChild(policyTitle);
  policy.appendChild(policyBody);
  panel.appendChild(policy);
  return { renderLog };
}
export {
  setup
};
