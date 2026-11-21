# Auto-Continue on Connection Loss

A [Lumiverse](https://github.com/prolix-oc/Lumiverse) Spindle extension that presses
**Continue** for you when a reply dies mid-stream because the connection to the
provider broke — and never presses it when the failure was about money,
credentials, moderation or a malformed request.

Leia em [português](README.pt-BR.md).

## Why it exists

Lumiverse already recovers from one kind of disconnection by itself. If your
**browser** loses the server, the generation keeps running in the backend
generation pool and the client re-syncs on reconnect, on tab focus, or when you
reopen the chat. Nothing is lost and no Continue is needed.

The gap is the other direction: the **server** losing the provider mid-stream.
There Lumiverse saves whatever text arrived as a partial message, shows the
error line in the chat, and waits for a human to press Continue. If you were
away from the keyboard, a 2000-token reply sits there half-written until you
come back.

This extension presses Continue — but only when the error actually looks like a
dropped connection.

## What it never retries

The decision lives in [`src/error-policy.ts`](src/error-policy.ts) and is
fail-closed: a failure is retried only when it matches the transient allowlist,
and the permanent denylist is checked first and wins. **An error it does not
recognise is left alone.**

Never continued:

| Class | Examples |
|---|---|
| Money | payment required, insufficient credits, quota exceeded, billing hard limit, spending limit, plan limit, `saldo insuficiente` |
| Credentials | invalid or missing API key, unauthorized, forbidden, expired token, suspended or deactivated account |
| Policy | moderation, content filter, blocked or flagged content |
| Impossible request | context length exceeded, token limit, unknown model, invalid parameter, `400`, `404`, `422` |
| Deliberate stops | a generation you stopped, a host-side abort, the pool killing a generation after 60 idle minutes |
| Anything unknown | no rule matched, so nothing happens |

The money rules beat the throttling rules on purpose. Providers like to dress a
billing wall up as a rate limit (`429 — you exceeded your current quota`), and
that must not trigger a retry that costs you another request.

Continued, after a short wait: `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`,
`ConnectionClosed`, `UND_ERR_*`, `terminated`, `premature close`,
`socket hang up`, `fetch failed`, `502`, `503`, `504`, provider internal errors.

Continued, after at least 20 seconds: real throttling — `429`, `rate limit`,
`overloaded`, "try again later".

You can add your own never-continue words in the settings panel; they are
checked before every built-in rule.

## Safety rails

- **There has to be something to continue.** A `normal` generation that
  produced no text leaves nothing to extend, so it does not fire; retrying from
  scratch is a different action. A failed `continue` is different: it persists
  nothing, so the event carries no content and no message id, while the reply
  it was extending still holds everything that arrived earlier. Those are
  retried — getting this backwards is what made 1.0.3 give up on the attempt
  that mattered.
- **Only `normal` and `continue` generations.** A swipe or background swipe
  writes into a slot that may not be the selected one, and Continue would
  extend the wrong text. Impersonate and quiet generations are skipped too.
- **Only in the active chat.** The host's Continue acts on whatever chat is
  open, so if you navigated away during the wait, it gives up.
- **Only one window.** Before continuing, a document takes a 15-second claim on
  the chat in `localStorage`, so two open windows produce one continue. The
  claim is re-entrant for the window that holds it, so your own second attempt
  is never locked out by your own first.
- **Never on top of another generation.** It follows
  `GENERATION_STARTED` / `ENDED` / `STOPPED` and cancels its pending continue as
  soon as anything starts generating in that chat — including you.
- **Stop is your decision.** A `GENERATION_STOPPED` cancels the wait and clears
  the counter.
- **Attempt ceiling.** Four automatic continues per reply by default (1 to 10),
  with the pause doubling each time (3s, 6s, 12s, …, capped at 120s). When the
  ceiling is hit it announces and stops. The counter resets on a clean finish
  or on a different reply, and only a *known* different message resets it — a
  continue that dies before its first token reports no message at all, and
  reading that as a new reply would remove the ceiling entirely.

## How it works

Spindle's backend API has no "continue this reply" call, and there is no
generation-error event. So this is a frontend-only extension:

1. It subscribes to `GENERATION_ENDED`, which the host emits on the error path
   too, carrying `errorCode`, the error message, `finish_reason`, and the
   partial `content` the host just persisted.
2. It classifies the failure, waits, and re-checks every guard.
3. It fires the host's own command through
   `ctx.host.surfaces.invoke({ kind: 'command', id: 'action-continue' })` — the
   same command the palette runs, so the reply is produced exactly as a manual
   Continue would produce it.

That one host command is why the only permission it asks for is `generation`.

## Install

**From GitHub** (how most people will install it):

1. Open the **Spindle Panel** (drawer → **Extensions**).
2. **Add Extension** → paste `https://github.com/caiohenriquerls/lumiverse-autocontinue`
   into *Install from Source*.
3. Review the permission (`generation`) and click **Install**.
4. New extensions arrive disabled: flip **Enable**, then grant `generation`.

`dist/frontend.js` is committed, so the install needs no build step and no
dependency download.

**From disk** (for development): drop the folder in `data/extensions/` on your
server, then **Add Extension** → **Import Local** as owner or admin.

## Settings

**Settings → Auto-Continue**:

- **Auto-continue after a dropped connection** — the master switch.
- **Maximum attempts per message** — 1 to 5, default 2.
- **Wait before continuing** — 1 to 120 seconds, default 3. Doubles per attempt.
- **Also continue a reply cut off by the token limit** — off by default. No
  error happened; the model simply hit its output cap. Turn it on and long
  replies grow on their own.
- **Announce what it is doing** — on by default.
- **Never continue when the error mentions** — your own words, one per line.
- **Recent decisions** — the last 20 things it decided and why.

## Accessibility

The status line is a `role="status"` / `aria-live="polite"` region, so a screen
reader announces each decision without stealing focus: "Connection lost.
Continuing in 3s…", "Continuing the reply (attempt 1 of 2).", "Stopped after 2
automatic continues. Over to you." Strings are Portuguese when the browser
locale is `pt`, English otherwise. The announcement can be turned off; the same
information still goes to the browser console.

## Why didn't it continue?

Every failure it could have continued leaves a line in **Settings →
Auto-Continue → Recent decisions**, newest first, and the same line goes to the
browser console prefixed with `[lumi_autocontinue]`. A line names either the
policy verdict (`Did not continue: permanent:payment`) or the guard that
stopped it (`Did not continue, guard: other-chat`). An empty log after a failed
reply means the extension is not running in that page at all — check that it is
enabled and that `generation` is granted.

**Reload after updating.** The same panel shows which version is live in the
page, and it can lag the version on the extension card: a loaded page keeps the
module it already imported. After **Update**, reload the page (or restart the
desktop app) before expecting the new behaviour. Each `setup()` also writes a
`status` beacon (version, start time, whether the host exposed its command
surfaces) to the extension's settings, so which build is live is answerable
without opening developer tools.

## Status

**1.0.3 is the first version that runs at all.** 1.0.0 through 1.0.2 were dead
on arrival, and the cause was one line:

```ts
ctx.settings.watch('config', ...)   // throws SETTING_KEY_INVALID:config
```

A private settings key must be `module:name` — two colon-separated segments —
and `watch()` enforces that *synchronously*. The throw landed inside `setup()`
before a single event subscription had been registered, so the host tore the
extension down at load every time. From the outside it looked exactly like an
extension that quietly decided not to continue anything: three real connection
drops, no continues, no log lines, no stored settings.

1.0.3 uses valid keys (`autocontinue:config`, `autocontinue:decisions`,
`autocontinue:status`) and, more importantly, is built so that this class of
mistake cannot repeat: the event subscriptions are registered first, and every
optional part — the notice, the stored settings, the panel, the status beacon —
is wrapped so a failure in it logs and is skipped instead of taking the feature
down. The fake host in the test suite now enforces the key rule too.

Fixed along the way, while the extension was never actually running:

- It compared the originating document id on the payload against its own and
  skipped on a mismatch. That id is whichever frontend session the server
  treats as the execution owner, which with two Lumiverse windows open is not
  necessarily the one you are reading. The `localStorage` claim settles
  single-firing instead, re-entrant for the window that holds it.
- Every refusal was silent. Hence the decision log and the status beacon.
- A chat whose generation never reported a terminal event stayed "busy"
  forever, disabling the extension there with no trace.

Field evidence since then (1.0.4): the extension fired, retried, and stopped
where it should — and then a manual Continue on the same chat succeeded where
its two automatic attempts had timed out. Persistence works; the ceiling was
just too low and one guard asked the wrong question. Both are fixed above.

The error policy is unit-tested against 34 payloads shaped like real provider
failures, and the guard chain has 16 tests driving real payloads through
`setup()` with a fake host (`bun test`). The path has still not been watched
end to end against a live provider drop, so report anything odd.

Known limits:

- A failure that produced no tokens at all is not continued, by design.
- The host's Continue command has no multiplayer-guest guard of its own. If you
  play as a room guest, leave the extension disabled.

## Development

```bash
bun install
bun run check   # typecheck + tests + build
```

- `src/error-policy.ts` — the decision. Pure, no host dependency, tested by
  `src/error-policy.test.ts`.
- `src/frontend.ts` — events, guards, the wait, the Continue invoke, and the
  settings panel. `src/frontend.test.ts` drives it with a fake host context.
- `src/strings.ts` — English and Portuguese strings.

`dist/frontend.js` is committed on purpose: Lumiverse treats a tracked `dist/`
as prebuilt and skips both the dependency install and the bundle step at install
time. Rebuild it (`bun run build`) in the same commit as any `src/` change.

## License

MIT — see [LICENSE](LICENSE).
