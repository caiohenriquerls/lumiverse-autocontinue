/**
 * Decides whether a failed generation may be auto-continued.
 *
 * The policy is a fail-closed allowlist. Only failures that look like a lost
 * connection or a transient upstream hiccup are eligible. Anything about
 * money, credentials, moderation or a malformed request is refused, and an
 * error the policy does not recognise is refused too - a silent retry on a
 * permanent failure burns credit (or patience) for nothing.
 *
 * Classification runs over two fields the host puts on GENERATION_ENDED:
 * `errorCode` (a provider code such as `insufficient_quota`, an HTTP status
 * text such as `Payment Required`, a Node/Bun socket code such as
 * `ECONNRESET`, or `http_<status>`) and the human-facing error message.
 */

export type FailureVerdict = {
  /** True only when every rule agrees this is worth continuing. */
  readonly retry: boolean
  /** Rate-limit style failure: wait noticeably longer before retrying. */
  readonly slow: boolean
  /** Short tag for logs and the status line. */
  readonly reason: string
}

export type FailureInput = {
  readonly errorCode?: string | undefined
  readonly error?: string | undefined
  readonly errorMessage?: string | undefined
}

/** Lowercase, turn every run of non-alphanumerics into one space. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** HTTP status carried either as `http_502` or inside `provider chat failed (502): ...`. */
export function extractStatus(rawCode: string, rawMessage: string): number | null {
  const fromCode = /\bhttp (\d{3})\b/.exec(normalize(rawCode))
  if (fromCode && fromCode[1]) return Number(fromCode[1])
  const fromMessage = /\((\d{3})\)/.exec(rawMessage)
  if (fromMessage && fromMessage[1]) return Number(fromMessage[1])
  return null
}

/** Permanent client-side failures. A retry can never fix these. */
const DENY_STATUS = new Set([400, 401, 402, 403, 404, 405, 406, 407, 409, 410, 413, 414, 415, 422, 451])

/** Transport and upstream failures a retry can plausibly fix. */
const ALLOW_STATUS = new Set([408, 425, 500, 502, 503, 504, 507, 508, 520, 521, 522, 523, 524, 525, 526, 527, 530])

/** Retryable, but only after a longer pause. */
const SLOW_STATUS = new Set([429])

/**
 * Checked first, and it wins over everything below: a provider that answers
 * "429 - you exceeded your current quota" is a billing wall wearing a
 * rate-limit hat, and auto-continuing into it is exactly what must not happen.
 */
const DENY_PATTERNS: readonly string[] = [
  // Money, plans, credit
  'payment', 'billing', 'insufficient', 'quota', 'credit', 'balance', 'funds', 'invoice',
  'subscription', 'upgrade', 'free tier', 'spending limit', 'hard limit', 'usage limit',
  'top up', 'topup', 'prepaid', 'pagamento', 'saldo', 'cobran', 'assinatura', 'fatura',
  // Credentials and access
  'api key', 'apikey', 'unauthorized', 'unauthenticated', 'authentication', 'authorization',
  'invalid key', 'invalid token', 'expired', 'forbidden', 'permission', 'not allowed',
  'access denied', 'suspended', 'deactivated', 'banned', 'no stored key', 'sign in', 'login',
  'nao autorizado', 'chave invalida', 'credencia',
  // Moderation and policy
  'moderation', 'content policy', 'content filter', 'safety', 'prohibited', 'violat',
  'flagged', 'blocked', 'refused to',
  // Malformed or impossible request
  'bad request', 'invalid request', 'unprocessable', 'validation', 'context length',
  'context window', 'maximum context', 'too many tokens', 'token limit', 'max tokens',
  'model not found', 'unknown model', 'invalid model', 'no such model', 'does not exist',
  'unsupported', 'not supported', 'deprecated', 'invalid parameter', 'not found',
  // Deliberate stops and host-side aborts: never ours to resume
  'abort', 'cancel', 'stopped by', 'no activity for',
  // Region and availability walls
  'unavailable in your', 'not available in', 'region',
]

/** Error codes that must never be retried even when the message reads transient. */
const DENY_CODES: readonly string[] = ['generation timeout', 'abort error', 'aborterror']

/** Lost connection or transient upstream trouble. */
const ALLOW_PATTERNS: readonly string[] = [
  // Node / Bun / undici socket codes
  'econnreset', 'econnaborted', 'econnrefused', 'etimedout', 'epipe', 'enetunreach',
  'enetdown', 'ehostunreach', 'enotfound', 'eai again', 'und err',
  'connectionclosed', 'connectionrefused', 'failedtoopensocket', 'failed to open socket',
  // Socket deaths in prose
  'socket hang up', 'socket closed', 'socket error', 'connection closed', 'connection reset',
  'connection error', 'connection lost', 'connection terminated', 'terminated',
  'premature close', 'stream closed', 'stream ended', 'unexpected end', 'incomplete',
  'fetch failed', 'failed to fetch', 'network', 'offline', 'dns', 'tls', 'handshake',
  'conexao', 'rede',
  // Upstream hiccups
  'bad gateway', 'service unavailable', 'gateway timeout', 'request timeout', 'timed out',
  'timeout', 'upstream', 'internal server error', 'server error', 'temporarily', 'try again',
]

/** Retryable, with a longer floor so a throttled provider is not hammered. */
const SLOW_PATTERNS: readonly string[] = [
  'rate limit', 'ratelimit', 'too many requests', 'overloaded', 'capacity', 'congest',
  'retry after', 'try again later', 'slow down',
]

function hits(haystack: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (pattern && haystack.includes(pattern)) return pattern
  }
  return null
}

/**
 * Decide the fate of one failed generation.
 *
 * `extraBlocked` holds the user's own never-continue words from settings; they
 * are checked before every built-in rule.
 */
export function classifyGenerationFailure(
  input: FailureInput,
  extraBlocked: readonly string[] = [],
): FailureVerdict {
  const rawCode = input.errorCode ?? ''
  const rawMessage = `${input.error ?? ''} ${input.errorMessage ?? ''}`
  const code = normalize(rawCode)
  const text = normalize(`${rawCode} ${rawMessage}`)

  if (!text) return { retry: false, slow: false, reason: 'no-error-text' }

  const custom = hits(text, extraBlocked.map(normalize).filter(Boolean))
  if (custom) return { retry: false, slow: false, reason: `blocked-by-user:${custom}` }

  const deniedCode = hits(code, DENY_CODES)
  if (deniedCode) return { retry: false, slow: false, reason: `permanent-code:${deniedCode}` }

  const denied = hits(text, DENY_PATTERNS)
  if (denied) return { retry: false, slow: false, reason: `permanent:${denied}` }

  const status = extractStatus(rawCode, rawMessage)
  if (status !== null && DENY_STATUS.has(status)) {
    return { retry: false, slow: false, reason: `permanent-status:${status}` }
  }

  if (status !== null && SLOW_STATUS.has(status)) {
    return { retry: true, slow: true, reason: `throttled-status:${status}` }
  }
  const slow = hits(text, SLOW_PATTERNS)
  if (slow) return { retry: true, slow: true, reason: `throttled:${slow}` }

  if (status !== null && ALLOW_STATUS.has(status)) {
    return { retry: true, slow: false, reason: `transient-status:${status}` }
  }
  const allowed = hits(text, ALLOW_PATTERNS)
  if (allowed) return { retry: true, slow: false, reason: `transient:${allowed}` }

  return { retry: false, slow: false, reason: 'unrecognised' }
}
