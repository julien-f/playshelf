# Plan: TV mode from a phone (phone-as-remote)

Status: reviewed (frontend, backend/security, user), awaiting the go-ahead. Branch `tv-remote`, own worktree (`node scripts/worktree.js tv-remote`), closed with `git merge --no-ff` carrying the CHANGELOG entry, after the user has tested it on their phone and TV and said OK.

## Why not casting (U217)

Spike on a real phone (2026-10-26, Android 12, TV with Chromecast that YouTube reaches): Firefox 158 has no `video.remote`; Chrome 155 has it but `watchAvailability` stays false with a plain native HLS `src`, its video menu has no Cast entry, `prompt()` rejects `NotAllowedError: The prompt was dismissed`. U217 is rewritten to this plan.

## Decided with the user

- Pairing: QR code + 6-character code on the TV; QR via `qrcode-generator` (new dependency, TV page only).
- Access: anyone with the code, no sign-in.
- Scope: everything presenting has (P/cast button, lightbox steering, private, chip remote), from a phone; a computer can drive a TV too.
- Transport: server relay, no new server dependency.

## Who it serves

A TV with a browser, or a computer on HDMI. A Chromecast alone can't open the page: the Connect dialog and features.md say so.

## Design

### Link abstraction (`presentationLink.ts`)

- `{ post(msg), onMessage(fn), onPeer(fn), close() }`; protocol messages unchanged.
- `localLink(mainId)`: today's `BroadcastChannel`.
- `relayLink(token)`: POST `/api/tv/send` (`keepalive: true`, so `pagehide` messages go out; `Authorization: Bearer`), receive over a streamed `fetch` of `/api/tv/stream`, NDJSON (new framing, not `/api/game-details/stream`'s SSE; its parser written once here), reconnecting with backoff; `{relay: …}` lines drive `onPeer`, `{msg}` lines `onMessage`. The room code is the `main` tag on both ends (a phone that takes over speaks the same tag).

### Server: `lib/tvRelay.js` (pure `createRelay({ now })`) + routes

- Rooms in memory (single process). A deploy drops them: the TV shows a new code; the phone, on a 401/404 from its stream, reads as unpaired.
- `POST /api/tv` → `{ code, token }`; `POST /api/tv/join` `{ code }` → `{ token }` (code only in a body: morgan logs paths); `GET /api/tv/stream`, `POST /api/tv/send` by token alone. Tokens `randomBytes(16)` base64url, compared with `timingSafeEqual`. The `?pair=` SPA load logs the code once: accepted.
- Code: 6 Crockford base32 characters (`crypto.randomInt`), shown `ABC·DEF`; join normalises case and O→0, I/L→1.
- Takeover: a new join replaces the host and revokes its token (its send/stream → 401); its open stream ends after `{relay:'replaced'}`.
- Forwarded lines are `{msg: <parsed body>}`, re-stringified; relay notices `{relay: 'peer'|'replaced'|'superseded'|'expired', …}` can't be forged. Body ≤ 4 KB through its own `express.json({ limit })` mounted ahead of the global parser (as `prefsRouter`); `type` checked against a per-direction allowlist (host→TV `ToPresentation`, TV→host `FromPresentationBody`), else 400.
- Streams: one per token (a second ends the first, which gets `{relay:'superseded'}` and doesn't reconnect); `close` clears its keep-alive (25 s) and starts the room's grace, as the `openStreams` close handler; a reader past ~64 KB `writableLength` is destroyed; one `unref()`ed sweep interval for expiry. `X-Accel-Buffering: no`.
- Expiry: unpaired 10 min; TV stream gone 2 min (a TV reload reconnects with its stored token within it); 12 h cap.
- Limits: `namedRateLimit` `tvCreate`, `tvSend` (the TV's 5 s `state` counts), `tvJoin` with `skipSuccessfulRequests` plus a global failed-join ceiling; ≤ 2 rooms created per client and 500 overall, the `openStreams` pattern (`recordLimiterTrip('tvRooms')`; the global cap never bypassed). Errors `{ error }` with 400/401/404/413/429.
- Metrics: `tvRelay: { rooms, paired, streams }` live, plus created/joined/expired/rejected-by-reason counters; nothing about content.
- No upstream request; trust tiers unaffected.

### TV page (`/tv` → `present.html` without `?main=`)

- `/tv` is an explicit route serving the built `present.html`, ahead of the SPA fallback.
- One DOM as today: pairing, idle and the paired view are overlays (`<Show>`) inside `root`, never wrapping `img`/`video`; no "Place on the other screen" button.
- Steps: a focused **Start** button (its activation enters fullscreen and unlocks sound while the host is at the TV; no Fullscreen API → "Use your TV browser's full-screen option" once) → QR + "Scan with your phone's camera, or open steam.isonoe.net/tv… type ABC·DEF on your phone" → paired.
- Paired and idle: dark screen, "Connected — present a game from your phone". The code never shows again until Disconnect. A join flashes "A new phone is driving this TV".
- Accepts media URLs only on `https:` `*.steamstatic.com` (anyone with the code can send it a message).
- Relay mode: `bye` does nothing (a phone locking keeps the media up); `close` fades to idle, staying paired; Disconnect or room expiry → pairing again. Never `window.close()`. Token in `localStorage` until expiry.
- Arrows/Enter pressed on the TV are relayed as today; with the host gone (peer down) they do nothing.

### Host side (phone or computer)

- `?pair=<code>` (the QR; `tv` is already the table-view param) added to `PARAM_ORDER`, or the Connect dialog's field → join, token in `localStorage` until a 401/404 (survives a discarded tab). Only the tab that presents streams and drives the TV (a `sessionStorage` flag set on join or `present()`), as today's per-tab rule.
- Connect a TV: a Preferences-popover item on every device; on touch, the panel's cast button opens it while unpaired (replacing the `not (any-pointer: fine)` rule hiding it). Dialog: labelled code field (`autocapitalize="characters"`, `autocomplete="off"`, `enterkeyhint="go"`), a wrong or expired code said next to it, the Chromecast caveat, fits 390 px, 44 px targets.
- Paired: `present()` posts `onAir`, never `window.open` (today's `win ? !win.closed : wasPresenting` branch). A computer paired to a TV presents there; Disconnect returns it to its local window.
- Lost/resume: in relay mode a peer-down notice calls `lost()` only after the room's 2 min TV grace, `presented()` kept meanwhile (a TV reload or Wi-Fi blip resumes through peer-up and its `hello`, as today); the heartbeat silence check is off; on `visibilitychange` to visible, reconnect, reset `lastSeen`, post `main` (the TV answers with its state).
- Chip: × stops presenting (TV goes idle, stays paired); paired and idle the chip shows "TV connected" with **Disconnect TV**; replaced, it says "Someone else joined this TV" with **Take it back** (re-join with the stored code).

## Steps (one commit each, each with its tests)

1. Delete this PLAN.md (U217 on main already points here; close U217 at the merge).
2. `presentationLink.ts`, both ends on `localLink()`; no behavior change (`SKIP_CHANGELOG=1`, e2e green).
3. `lib/tvRelay.js` + routes, limits, metrics. `test/tvRelay.test.js` (pure relay, `t.mock.timers` with `apis: ['setInterval','Date']`), stream routes over `app.listen(0)` + `fetch` with `AbortController`, caps in their own file with `RATE_LIMIT_ENABLED=true` (as `test/streamCap.test.js`); cases: second stream superseded (no reconnect loop), takeover revokes the old host token, forged relay line, wrong-direction type, oversized body, stalled reader, expiry.
4. TV page: `/tv` route (supertest checks it serves `present.html`), Start, pairing (QR), idle, URL allowlist, relay-mode `bye`/`close`, reload reconnect. E2E hook (`presentationHooks.ts` style) swapping `relayLink`'s transport for a `BroadcastChannel` named after the code (`route.fulfill` can't mock a long-lived stream); `/api/tv` JSON mocked; `presTest.heard` on the TV page.
   5a. `?pair=` join, token storage, 401/404 → unpaired.
   5b. Connect dialog, Preferences item, touch cast button.
   5c. `present()` over the relay, lost/resume, chip states (Stop, Disconnect, Take it back), e2e (a TV reload during a trailer; two tabs, one TV).
5. Journey C9 and its remaining edges in e2e; docs.

## Docs

- features.md: "Presenting on a TV from your phone" (the Chromecast caveat); drop "no Present button on a phone or tablet".
- panel-and-lightbox.md ("The presentation window"): the link, the TV page's states; frontend.md: `?pair=` in URL state; architecture.md: `/api/tv` routes; observability.md: relay limiters and metrics; journeys.md **C9 Present from my phone on a TV**, edges: `/tv` opened with a remote; Start pressed or skipped; no fullscreen; QR scanned with the camera app; code wrong, lower-case or expired; phone locked during a trailer (plays on, chip resyncs); phone tab discarded (still paired); TV reloaded (reconnects within 2 min, else a new code); TV Wi-Fi dropping; server restarted (re-pair); a second phone takes over, the first takes it back; Stop then present again without rescanning; Disconnect; two TVs, one phone; two tabs, one TV (only the presenting one drives it); a computer driving a TV; private mode from a phone; the 12 h cap.
- pitfalls.md as found. CHANGELOG (Added) at the merge.

## To check on the live site (with approval, before relying on it there)

- `TRUST_PROXY` is set (else everyone behind the proxy is one client for the caps).
- The reverse proxy doesn't buffer streams and its read timeout exceeds 25 s; HTTP/2 (under HTTP/1.1 the relay stream takes one of six connections).
