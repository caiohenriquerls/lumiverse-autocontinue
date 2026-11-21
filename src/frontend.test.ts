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

function makeHarness(activeChatId: string | null = 'chat-1') {
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
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      watch: () => () => {},
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

  // Default ceiling is 2 attempts on the same message.
  harness.emit('GENERATION_ENDED', timedOut)
  harness.runTimers()
  harness.emit('GENERATION_ENDED', timedOut)
  harness.runTimers()
  harness.emit('GENERATION_ENDED', timedOut)
  harness.runTimers()

  expect(harness.invoked.length).toBe(2)
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
