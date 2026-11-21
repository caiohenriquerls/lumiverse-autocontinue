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
var CONTINUE_COMMAND = "action-continue";
var CLAIM_PREFIX = "spindle:lumi_autocontinue:claim:";
var CLAIM_TTL_MS = 15000;
var SLOW_FLOOR_MS = 20000;
var MAX_DELAY_MS = 120000;
var ATTEMPT_RESET_MS = 10 * 60000;
var NOTICE_TTL_MS = 7000;
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
function claimChat(chatId) {
  const key = `${CLAIM_PREFIX}${chatId}`;
  try {
    const now = Date.now();
    const existing = window.localStorage.getItem(key);
    if (existing) {
      const parsed = JSON.parse(existing);
      if (typeof parsed?.at === "number" && now - parsed.at < CLAIM_TTL_MS)
        return false;
    }
    const token = `${now}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(key, JSON.stringify({ at: now, token }));
    const readBack = window.localStorage.getItem(key);
    if (!readBack)
      return true;
    return JSON.parse(readBack)?.token === token;
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
    .lac-policy {
      padding: 12px 14px;
      border: 1px solid var(--lumiverse-border, rgba(127,127,127,.4));
      border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-fill-subtle, transparent);
    }
    .lac-policy-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  `);
  disposers.push(removeStyle);
  const noticeWrapper = ctx.dom.inject("body", '<div class="lac-notice" role="status" aria-live="polite" aria-atomic="true"></div>');
  const notice = noticeWrapper.querySelector(".lac-notice") ?? noticeWrapper;
  let noticeTimer = null;
  function announce(text) {
    if (destroyed)
      return;
    console.info(`[lumi_autocontinue] ${text}`);
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
    const set = running.get(chatId);
    return !!set && set.size > 0;
  }
  function markStarted(chatId, generationId) {
    const set = running.get(chatId) ?? new Set;
    set.add(generationId ?? "unknown");
    running.set(chatId, set);
  }
  function markFinished(chatId, generationId) {
    const set = running.get(chatId);
    if (!set)
      return;
    set.delete(generationId ?? "unknown");
    if (set.size === 0)
      running.delete(chatId);
  }
  function ownsGeneration(payload) {
    const owner = str(payload.frontendSessionId);
    const mine = typeof ctx.frontendSessionId === "string" ? ctx.frontendSessionId : undefined;
    if (owner && mine)
      return owner === mine;
    try {
      return document.visibilityState === "visible";
    } catch {
      return true;
    }
  }
  function scheduleContinue(chatId, messageId, delayMs) {
    cancelPending();
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    announce(strings.waiting(seconds));
    const timer = window.setTimeout(() => {
      pending = null;
      fireContinue(chatId, messageId);
    }, delayMs);
    pending = { chatId, timer };
  }
  async function fireContinue(chatId, messageId) {
    if (destroyed || !config.enabled)
      return;
    if (ctx.getActiveChat().chatId !== chatId)
      return;
    if (isRunning(chatId))
      return;
    const surfaces = ctx.host.surfaces;
    if (!surfaces)
      return;
    const available = surfaces.list(["command"]).some((surface) => surface.id === CONTINUE_COMMAND && surface.invocable !== false);
    if (!available) {
      console.warn("[lumi_autocontinue] the host does not expose action-continue to this extension");
      return;
    }
    if (!claimChat(chatId))
      return;
    const record = attempts.get(chatId) ?? { count: 0, messageId, at: Date.now() };
    record.count += 1;
    record.messageId = messageId;
    record.at = Date.now();
    attempts.set(chatId, record);
    announce(strings.continuing(record.count, config.maxAttempts));
    try {
      await surfaces.invoke({ kind: "command", id: CONTINUE_COMMAND });
    } catch (error) {
      console.warn("[lumi_autocontinue] continue failed to start", error);
      announce(strings.failed);
    }
  }
  function onGenerationEnded(raw) {
    const payload = raw ?? {};
    const chatId = str(payload.chatId);
    const generationId = str(payload.generationId);
    if (!chatId)
      return;
    markFinished(chatId, generationId);
    if (!config.enabled)
      return;
    const error = str(payload.error) ?? str(payload.errorMessage);
    const truncated = !error && str(payload.finish_reason) === "length";
    if (!error && !truncated) {
      attempts.delete(chatId);
      cancelPending(chatId);
      return;
    }
    if (truncated && !config.continueOnTruncated)
      return;
    const generationType = str(payload.generationType) ?? "normal";
    if (generationType !== "normal" && generationType !== "continue")
      return;
    const content = str(payload.content);
    if (!content || !content.trim())
      return;
    if (!ownsGeneration(payload))
      return;
    if (ctx.getActiveChat().chatId !== chatId)
      return;
    if (isRunning(chatId))
      return;
    const verdict = error ? classifyGenerationFailure({ errorCode: str(payload.errorCode), error: str(payload.error), errorMessage: str(payload.errorMessage) }, parseBlockWords(config.blockWords)) : { retry: true, slow: false, reason: "truncated" };
    if (!verdict.retry) {
      console.info(`[lumi_autocontinue] leaving this one alone (${verdict.reason})`);
      return;
    }
    const messageId = str(payload.messageId);
    let record = attempts.get(chatId);
    if (record && (record.messageId !== messageId || Date.now() - record.at > ATTEMPT_RESET_MS)) {
      record = undefined;
      attempts.delete(chatId);
    }
    const spent = record?.count ?? 0;
    if (spent >= config.maxAttempts) {
      announce(strings.exhausted(config.maxAttempts));
      return;
    }
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
    markFinished(chatId, str(payload.generationId));
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
    buildSettingsPanel(ctx, tab.root, strings, () => config, (patch) => {
      config = normalizeConfig({ ...config, ...patch });
      settings.set(SETTINGS_KEY, config).catch(() => {});
    });
  }
  if (!ctx.host.surfaces) {
    console.warn("[lumi_autocontinue] this host exposes no command surfaces; the extension cannot continue anything");
  }
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
function buildSettingsPanel(ctx, root, strings, read, write) {
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
  const policy = ctx.dom.createElement("div", { class: "lac-policy" });
  const policyTitle = ctx.dom.createElement("div", { class: "lac-policy-title" });
  policyTitle.textContent = strings.policyTitle;
  const policyBody = ctx.dom.createElement("p", { class: "lac-help" });
  policyBody.textContent = strings.policyBody;
  policy.appendChild(policyTitle);
  policy.appendChild(policyBody);
  panel.appendChild(policy);
}
export {
  setup
};
