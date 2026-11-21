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

- **There has to be partial text.** With nothing generated there is nothing to
  continue, and it does not fire. (Retrying from scratch is a different action.)
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
- **Attempt ceiling.** Two automatic continues per message by default, with the
  pause doubling each time (3s, 6s, …, capped at 120s). When the ceiling is hit
  it announces and stops. The counter resets on a clean finish, on a different
  message, or after 10 minutes without a new failure.

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

## Status

1.0.1 is the version worth running. 1.0.0 had two defects that could make it do
nothing at all, both found the first time a real connection drop hit it:

- It compared the originating document id on the payload against its own and
  skipped on a mismatch. That id is whichever frontend session the server
  currently treats as the execution owner, which with two Lumiverse windows
  open is not necessarily the one you are reading. The claim in `localStorage`
  now settles single-firing instead.
- Every refusal was silent, so "it skipped a continuable failure" and "it is
  not loaded" looked identical from the outside. Hence the decision log.

Also fixed: a chat whose generation never reported a terminal event stayed
"busy" forever and quietly disabled the extension there; and a second attempt
could be blocked by the first attempt's own cross-window claim.

The error policy is unit-tested against 34 payloads shaped like real provider
failures, including the field case that exposed all of the above, and the guard
chain has 11 tests driving real payloads through `setup()` with a fake host
(`bun test`). The path has still not been watched end to end against a live
provider drop, so report anything odd.

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
