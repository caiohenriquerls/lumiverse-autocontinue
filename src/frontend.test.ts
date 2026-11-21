/**
 * Smoke tests for the guard chain, with a fake host context.
 *
 * These exist because 1.0.0 shipped a guard chain where every refusal was
 * silent, so a failure that should have been continued looked exactly like an
 * extension that was not running at all. The tests drive real
 * GENERATION_ENDED payloads (including the one from the field:
 * `generation_failed` / "The operation timed out.") through `setup()` and
 * assert whether the host's Continue command gets invoked.
 *
 * Run with `bun test`.
 */

import { beforeEach, expect, test } from 'bun:test'

class FakeElement {
  children: FakeElement[] = []
  attributes = new Map<string, string>()
  textContent = ''
  className = ''

  constructor(className = '') {
    this.className = className
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  querySelector(selector: string): FakeElement | null {
    const wanted = selector.replace(/^\./, '')
    if (this.className === wanted) return this
    for (const child of this.children) {
      const hit = child.querySelector(selector)
      if (hit) return hit
    }
    return null
  }
}

type Timer = { id: number; fn: () => void; delay: number }

/**
 * The host's own rule for an extension-private settings key, copied from
 * `frontend/src/lib/spindle/settings-bridge.ts`: `module:name`, two segments,
 * the module matching /^[a-z][a-z0-9_]*$/. `watch()` enforces it
 * synchronously, which is how a one-segment key took the whole extension down
 * at load in 1.0.0 through 1.0.2. The fake host enforces it too, so the same
 * mistake fails here instead of in production.
 */
function assertHostSettingKey(key: string): void {
  const segments = key.split(':')
  if (key.startsWith('spindle:')) throw new Error('SETTING_NAMESPACE_INVALID')
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`SETTING_KEY_INVALID:${key}`)
  }
  if (!/^[a-z][a-z0-9_]*$/.test(segments[0] ?? '')) {
    throw new Error(`SETTING_MODULE_INVALID:${segments[0] ?? ''}`)
  }
}

function makeHarness(activeChatId: string | null = 'chat-1', options: { brokenSettings?: boolean } = {}) {
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
  const timers: Timer[] = []
  const invoked: Array<{ kind: string; id: string }> = []
  const storage = new Map<string, string>()
  let nextTimerId = 1

  ;(globalThis as any).window = {
    setTimeout: (fn: () => void, delay: number) => {
      const timer = { id: nextTimerId++, fn, delay }
      timers.push(timer)
      return timer.id
    },
    clearTimeout: (id: number) => {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index !== -1) timers.splice(index, 1)
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  }
  ;(globalThis as any).navigator = { language: 'en-US', languages: ['en-US'] }

  const ctx = {
    frontendSessionId: 'this-document',
    host: {
      descriptorVersion: 1,
      lumiverseVersion: '1.3.0',
      capabilities: {},
      extensionInstallationId: 'test',
      surfaces: {
        list: () => [{ kind: 'command', id: 'action-continue', label: 'Continue Generation' }],
        invoke: async (ref: { kind: string; id: string }) => {
          invoked.push(ref)
        },
        subscribe: () => () => {},
      },
    },
    dom: {
      addStyle: () => () => {},
      inject: (_target: string, html: string) => {
        const wrapper = new FakeElement('wrapper')
        const inner = new FakeElement(/class="([a-z-]+)"/.exec(html)?.[1] ?? 'inner')
        wrapper.appendChild(inner)
        return wrapper
      },
      uninject: () => {},
      createElement: (_tag: string, attrs?: Record<string, string>) => new FakeElement(attrs?.class ?? ''),
      cleanup: () => {},
    },
    components: {
      mountSwitch: () => ({}),
      mountNumericInput: () => ({}),
      mountTextArea: () => ({}),
    },
    ui: {
      registerSettingsTab: () => ({
        root: new FakeElement('tab-root'),
        registrationId: 'r1',
        tabId: 'lumi_autocontinue',
        destroy: () => {},
        onActivate: () => () => {},
        setTitle: () => {},
        activate: () => {},
      }),
    },
    settings: {
      get: async (key: string) => {
        if (options.brokenSettings) throw new Error('SETTINGS_UNAVAILABLE')
        assertHostSettingKey(key)
        return undefined
      },
      set: async (key: string) => {
        if (options.brokenSettings) throw new Error('SETTINGS_UNAVAILABLE')
        assertHostSettingKey(key)
      },
      remove: async () => {},
      // Synchronous, exactly like the host's.
      watch: (key: string) => {
        if (options.brokenSettings) throw new Error('SETTINGS_UNAVAILABLE')
        assertHostSettingKey(key)
        return () => {}
      },
    },
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => {
          const current = handlers.get(event) ?? []
          handlers.set(
            event,
            current.filter((entry) => entry !== handler),
          )
        }
      },
      emit: () => {},
    },
    getActiveChat: () => ({ chatId: activeChatId, characterId: null }),
  }

  const emit = (event: string, payload: unknown): void => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
  }

  const runTimers = (): void => {
    const queued = timers.splice(0)
    for (const timer of queued) timer.fn()
  }

  const delays = (): number[] => timers.map((timer) => timer.delay)

  return { ctx, emit, runTimers, timers, delays, invoked, handlers, storage }
}

/** The real payload from the field, as the host emits it on the error path. */
const timedOut = {
  chatId: 'chat-1',
  generationId: 'gen-1',
  messageId: 'msg-1',
  content: 'The scene was half written when the socket died',
  error: 'The operation timed out.',
  errorCode: 'generation_failed',
  generationType: 'normal',
  frontendSessionId: 'this-document',
}

let teardown: (() => void) | undefined

beforeEach(() => {
  teardown?.()
  teardown = undefined
})

test('setup subscribes to the generation lifecycle and returns a teardown', () => {
  const harness = makeHarness()
  const result = (setupExtension(harness.ctx) as () => void)
  teardown = result
  expect(typeof result).toBe('function')
  for (const event of ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_SWITCHED']) {
    expect(harness.handlers.get(event)?.length ?? 0, `missing subscription: ${event}`).toBe(1)
  }
})

test('a dropped connection schedules and fires the host Continue command', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_STARTED', { chatId: 'chat-1', generationId: 'gen-1' })
  harness.emit('GENERATION_ENDED', timedOut)

  // The notice pill schedules a timer of its own, so look for the delay the
  // policy asked for rather than counting every pending timer.
  expect(harness.delays(), 'a continue should be scheduled').toContain(3000)

  harness.runTimers()
  expect(harness.invoked).toEqual([{ kind: 'command', id: 'action-continue' }])
})

test('a billing failure never fires', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', {
    ...timedOut,
    error: 'You exceeded your current quota, please check your plan and billing details',
    errorCode: 'insufficient_quota',
  })

  expect(harness.timers.length).toBe(0)
  harness.runTimers()
  expect(harness.invoked).toEqual([])
})

test('a generation owned by another document is still continued (1.0.0 regression)', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', { ...timedOut, frontendSessionId: 'some-other-window' })

  harness.runTimers()
  expect(harness.invoked.length, 'the session id must not gate the continue').toBe(1)
})

test('a terminal event for one generation unwedges the chat (stale-busy regression)', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  // A start whose terminal event never arrives with the same id.
  harness.emit('GENERATION_STARTED', { chatId: 'chat-1', generationId: 'ghost' })
  harness.emit('GENERATION_ENDED', timedOut)

  harness.runTimers()
  expect(harness.invoked.length, 'a stale running entry must not disable the chat').toBe(1)
})

test('a clean finish does nothing', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', {
    chatId: 'chat-1',
    generationId: 'gen-1',
    messageId: 'msg-1',
    content: 'a complete reply',
    finish_reason: 'stop',
    generationType: 'normal',
  })

  expect(harness.timers.length).toBe(0)
  harness.runTimers()
  expect(harness.invoked).toEqual([])
})

test('a user stop cancels a pending continue', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', timedOut)
  expect(harness.delays()).toContain(3000)

  harness.emit('GENERATION_STOPPED', { chatId: 'chat-1', generationId: 'gen-2' })
  expect(harness.delays(), 'the pending continue should be gone').not.toContain(3000)
  harness.runTimers()
  expect(harness.invoked).toEqual([])
})

test('a failure in a chat you are no longer reading does not fire', () => {
  const harness = makeHarness('another-chat')
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', timedOut)
  harness.runTimers()
  expect(harness.invoked).toEqual([])
})

test('a swipe failure is left alone', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', { ...timedOut, generationType: 'swipe' })
  harness.runTimers()
  expect(harness.invoked).toEqual([])
})

test('a failure with no partial text is left alone', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', { ...timedOut, content: '' })
  harness.runTimers()
  expect(harness.invoked).toEqual([])
})

test('the attempt ceiling stops the loop', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  // Default ceiling is 4 attempts on the same reply.
  for (let round = 0; round < 6; round++) {
    harness.emit('GENERATION_ENDED', timedOut)
    harness.runTimers()
  }

  expect(harness.invoked.length).toBe(4)
})

/**
 * A continue that dies before its first token persists nothing, so the event
 * carries neither content nor messageId - while the reply it was extending
 * still holds everything that arrived earlier. 1.0.3 read that as "nothing to
 * continue" and gave up on the attempt that mattered.
 */
const continueDiedEmpty = {
  chatId: 'chat-1',
  generationId: 'gen-2',
  content: '',
  error: 'The operation timed out.',
  errorCode: 'generation_failed',
  generationType: 'continue',
}

test('a continue that produced nothing is still retried', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', continueDiedEmpty)
  harness.runTimers()

  expect(harness.invoked.length, 'an empty continue must not end the chain').toBe(1)
})

test('a normal generation that produced nothing is left alone', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  harness.emit('GENERATION_ENDED', { ...continueDiedEmpty, generationType: 'normal' })
  harness.runTimers()

  expect(harness.invoked).toEqual([])
})

test('empty continues cannot loop past the ceiling', () => {
  const harness = makeHarness()
  teardown = setupExtension(harness.ctx)

  // The first failure anchors the counter on a real message, then every
  // retry comes back with no messageId at all. Treating that absence as a
  // new reply would reset the count and retry forever.
  harness.emit('GENERATION_ENDED', timedOut)
  harness.runTimers()
  for (let round = 0; round < 8; round++) {
    harness.emit('GENERATION_ENDED', continueDiedEmpty)
    harness.runTimers()
  }

  expect(harness.invoked.length).toBe(4)
})

test('every settings key the extension uses is valid for the host', () => {
  const { SETTINGS_KEY, DECISIONS_KEY, STATUS_KEY } = require('./frontend') as typeof import('./frontend')
  for (const key of [SETTINGS_KEY, DECISIONS_KEY, STATUS_KEY]) {
    expect(() => assertHostSettingKey(key), `rejected by the host: ${key}`).not.toThrow()
  }
})

test('a settings API that fails on everything does not disable the extension', () => {
  const harness = makeHarness('chat-1', { brokenSettings: true })
  teardown = setupExtension(harness.ctx)

  // The subscriptions are what the feature is. They must survive a broken
  // optional subsystem - this is the 1.0.0-to-1.0.2 regression.
  expect(harness.handlers.get('GENERATION_ENDED')?.length ?? 0).toBe(1)

  harness.emit('GENERATION_ENDED', timedOut)
  harness.runTimers()
  expect(harness.invoked.length, 'the continue must still fire').toBe(1)
})

/**
 * Imported lazily so the global window/navigator stubs exist before the module
 * body of `frontend.ts` is first used.
 */
function setupExtension(ctx: unknown): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setup } = require('./frontend') as typeof import('./frontend')
  return setup(ctx as never) as () => void
}
