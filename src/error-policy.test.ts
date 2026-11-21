/**
 * Run with `bun test` from the extension folder.
 *
 * The samples are shaped like the real GENERATION_ENDED payloads: `errorCode`
 * is whatever the host put there (a provider code, an HTTP status text, a Bun
 * socket code, or `http_<status>`) and the message is the human-facing text.
 */

import { expect, test } from 'bun:test'
import { classifyGenerationFailure } from './error-policy'

const continues = [
  // Seen in the field on 2026-11-21: a 12k-character reply cut off mid-stream.
  // Bun's fetch timeout carries no provider code, so the host falls back to
  // `generation_failed` and the message is all there is to go on.
  { errorCode: 'generation_failed', error: 'The operation timed out.' },
  { errorCode: 'TimeoutError', error: 'The operation timed out.' },
  { errorCode: 'ECONNRESET', error: 'read ECONNRESET' },
  { errorCode: 'ConnectionClosed', error: 'The socket connection was closed unexpectedly' },
  { errorCode: 'generation_failed', error: 'terminated' },
  { errorCode: 'generation_failed', error: 'fetch failed' },
  { errorCode: 'UND_ERR_SOCKET', error: 'other side closed' },
  { errorCode: 'ERR_STREAM_PREMATURE_CLOSE', error: 'Premature close' },
  { errorCode: 'ETIMEDOUT', error: 'NanoGPT chat failed: connect ETIMEDOUT' },
  { errorCode: 'Bad Gateway', error: 'NanoGPT chat failed (502): Bad Gateway' },
  { errorCode: 'http_503', error: 'provider chat failed (503): upstream unavailable' },
  { errorCode: 'Gateway Timeout', error: 'OpenRouter chat failed (504): Gateway Timeout' },
  { errorCode: 'generation_failed', error: 'Internal server error' },
]

const slow = [
  { errorCode: 'rate_limit_exceeded', error: 'Anthropic chat failed (429): rate limit reached' },
  { errorCode: 'overloaded_error', error: 'Overloaded' },
  { errorCode: 'http_429', error: 'Too Many Requests' },
]

const refuses = [
  // Money
  { errorCode: 'insufficient_quota', error: 'You exceeded your current quota, please check your plan and billing details' },
  { errorCode: 'Payment Required', error: 'NanoGPT chat failed (402): Payment Required' },
  { errorCode: 'http_429', error: 'Insufficient credits. Add more credits to continue.' },
  { errorCode: 'billing_hard_limit_reached', error: 'Billing hard limit has been reached' },
  { errorCode: 'generation_failed', error: 'Saldo insuficiente para esta requisicao' },
  // Credentials
  { errorCode: 'invalid_api_key', error: 'Incorrect API key provided' },
  { errorCode: 'Unauthorized', error: 'provider chat failed (401): Unauthorized' },
  { errorCode: 'http_403', error: 'Forbidden' },
  { errorCode: 'authentication_error', error: 'x-api-key header is invalid' },
  // Policy
  { errorCode: 'content_filter', error: 'The response was blocked by the content filter' },
  { errorCode: 'generation_failed', error: 'Request flagged by moderation' },
  // Request shape
  { errorCode: 'context_length_exceeded', error: 'This model supports at most 200000 tokens' },
  { errorCode: 'model_not_found', error: 'The model does not exist' },
  { errorCode: 'http_400', error: 'Bad Request: unsupported parameter' },
  // Stops and stalls
  { errorCode: 'generation_timeout', error: 'Generation timed out: no activity for 60 minutes' },
  { errorCode: 'AbortError', error: 'The operation was aborted' },
  // Nothing recognisable
  { errorCode: 'generation_failed', error: 'Something went sideways' },
  { errorCode: '', error: '' },
]

test('transient connection failures are continued', () => {
  for (const sample of continues) {
    const verdict = classifyGenerationFailure(sample)
    expect(verdict.retry, `${sample.errorCode} / ${sample.error} -> ${verdict.reason}`).toBe(true)
    expect(verdict.slow, `${sample.errorCode} should not be slow`).toBe(false)
  }
})

test('throttling is continued, but slowly', () => {
  for (const sample of slow) {
    const verdict = classifyGenerationFailure(sample)
    expect(verdict.retry, `${sample.errorCode} -> ${verdict.reason}`).toBe(true)
    expect(verdict.slow, `${sample.errorCode} -> ${verdict.reason}`).toBe(true)
  }
})

test('billing, credential, policy and unknown failures are refused', () => {
  for (const sample of refuses) {
    const verdict = classifyGenerationFailure(sample)
    expect(verdict.retry, `${sample.errorCode} / ${sample.error} -> ${verdict.reason}`).toBe(false)
  }
})

test('user words beat every built-in rule', () => {
  const sample = { errorCode: 'ECONNRESET', error: 'read ECONNRESET on my-gateway' }
  expect(classifyGenerationFailure(sample).retry).toBe(true)
  expect(classifyGenerationFailure(sample, ['my-gateway']).retry).toBe(false)
  expect(classifyGenerationFailure(sample, ['my-gateway']).reason).toContain('blocked-by-user')
})
