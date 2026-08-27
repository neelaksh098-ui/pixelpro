# Pixel Pro — Netlify Deploy Guide

Pixel Pro uses **Groq for fast everyday AI** and **Tavily Search for live/current web results**. Both API keys stay on Netlify Functions and are never sent to the browser.

## Netlify environment variables

Add these two variables to the existing Netlify site:

- `GROQ_KEY` — your Groq API key
- `TAVILY_API_KEY` — your Tavily API key
### Email sending (the composer's mail-toggle icon)

Pick ONE provider. Brevo is used when both are configured.

**Brevo — recommended, works for every user with no domain purchase**

- `BREVO_API_KEY` — from https://app.brevo.com → Settings → SMTP & API → API Keys → Generate.
- `BREVO_FROM` — the sender address you verified in Brevo, e.g. `Pixel Pro <you@gmail.com>`.
  Add it under Brevo → Senders, Domains & Dedicated IPs → Senders → Add a sender, then click
  the confirmation link Brevo emails you.

Brevo verifies a single ordinary address (an ordinary Gmail is fine), so it can deliver to
**any** signed-in user's inbox. Free tier: 300 emails/day. This is the setup to use if other
people will use the app.

**Resend — only reaches your own inbox unless you own a domain**

- `RESEND_API_KEY` — from https://resend.com/api-keys (100 emails/day free).
- `RESEND_FROM` — optional; e.g. `Pixel Pro <noreply@yourdomain.com>` once a domain is verified.

Resend's shared `onboarding@resend.dev` sender can only deliver to the Resend account owner's
own address, so other users' emails are rejected. To reach anyone you must verify a domain you
own and set `RESEND_FROM` to an address on it.

**Without either provider** the mail toggle still works — it opens a pre-filled Gmail compose
tab instead of sending directly. The same fallback kicks in if a send is rejected, so the
feature never dead-ends.

Note on deliverability: sending "from" a free-provider address (gmail.com) through a third party
can occasionally land in spam, because gmail.com's DMARC policy doesn't authorise it. It works,
but a verified domain of your own is the robust long-term answer.
- `CARTESIA_API_KEY` — from https://play.cartesia.ai/keys
- `CARTESIA_MODEL` — optional, defaults to `sonic-3.6`
- `CARTESIA_VOICE_ID` — optional, defaults to `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4` ("Skyler")
- `CARTESIA_VOICE_ID_MALE` / `CARTESIA_VOICE_ID_FEMALE` — optional per-gender overrides
- `CARTESIA_FORMAT` — optional, `wav` (default) or `mp3`
- `CARTESIA_SAMPLE_RATE` — optional, defaults to `16000`
- `CARTESIA_SPEED` — optional, e.g. `1.1`
- `CARTESIA_VERSION` — optional, defaults to `2024-06-10`

Cartesia has been removed entirely. If a Cartesia call fails the app falls
back to the browser's own voice so a reply is never silent.

**Why `/tts/bytes` and not the WebSocket.** Cartesia's lowest-latency path is
`wss://api.cartesia.ai/tts/websocket`, fed token-by-token straight from the LLM
stream. That needs a process that stays alive holding two sockets at once.
Netlify Functions are request/response and are destroyed when the response
ends, so there is nowhere for that process to live; and the browser can only
hold the socket itself by being handed the Cartesia key, which would publish it
to every visitor. `/tts/bytes` is one round trip, and Sonic's time-to-first-byte
is tens of milliseconds, so most of the advantage is kept. What is lost is
overlapping synthesis with generation — roughly one sentence of latency on a
long reply. Getting that back means moving off Netlify Functions to something
long-lived: Fly, Render, Railway, or a Cloudflare Durable Object, which would
proxy the socket and keep the key server-side.

**Format.** `wav`/`pcm_s16le`/16000 is the default because it is genuinely
uncompressed — the encoder does no work, which is the point of raw PCM — and a
WAV header is the one container `<audio>` plays with no decode step. Set
`CARTESIA_FORMAT=mp3` if the wire cost matters more than the encode cost, which
it does on a slow mobile connection: WAV is roughly ten times the bytes of a
64 kbps MP3 of the same speech.

Delete the old Google AI provider after the new deployment is working.

## Architecture

```text
Normal question
  browser → /.netlify/functions/groq → Groq

Current/live question
  browser → /.netlify/functions/tavily → Tavily Search
          → /.netlify/functions/groq → concise grounded answer

Image question
  browser → /.netlify/functions/groq → Groq vision model
```

## Live search behavior

Pixel Pro automatically routes questions about current news, today's events, sports scores/results, winners, weather, prices, launches/releases, current products such as new phones, schedules and similar changing information through Tavily.

Everyday/static questions stay on the faster Groq-only path.

## Authentication

Google sign-in uses Firebase `signInWithPopup()` with the OAuth parameter `prompt: select_account`, so the account chooser is shown instead of silently reusing the last Google account.

When a signed-in user taps the Google account button, Pixel Pro opens a confirmation dialog. Sign-out happens only after pressing **Sign out**.

## Deploy

Use the existing Netlify site and deploy this folder normally. Do not create a new site unless you intentionally want a separate app.

After deployment, test:

1. `What is 2+2?` → Groq-only fast answer.
2. `What is the latest iPhone model?` → Tavily + Groq, with live sources.
3. `Who won today's match?` → Tavily + Groq, with live sources.
4. `What is the weather today in Kolkata?` → Tavily + Groq, with live sources.
5. Tap the signed-in Google button → confirmation appears before sign-out.
6. Sign in again → Google account chooser appears.

## Voice

Pixel Pro uses Cartesia Sonic for spoken responses, including the Pixel Live voice orb and normal chat speech. Voice input still uses the browser Web Speech API when available, and the Live screen also includes a text command box so commands can be typed instead of spoken.

## Android APK — removing the URL bar (RESOLVED)

The APK/AAB was built with **PWABuilder** (confirmed from the Google Play package: `Readme.html` redirects to `docs.pwabuilder.com`, and the APK bundles Google's own `androidbrowserhelper` Trusted Web Activity library — verified directly inside the manifest). This means the app is **already a genuine TWA**, not a Custom Tab wrapper. The URL bar you're seeing is Android's documented, intentional fallback: a TWA shows browser chrome specifically when it *can't* verify the Digital Asset Link, and falls back to it silently otherwise.

Verified directly from the signing keystore inside the package (`signing.keystore`, alias `my-key-alias`) — not just read from a text file:

- **Package name:** `app.netlify.pixelpro7.twa`
- **SHA-256 fingerprint:** `1F:47:0C:B6:BC:18:1B:AF:B0:BE:1B:7D:7C:5B:CA:77:32:B3:9D:B0:EE:A4:CE:73:18:36:EB:97:F2:E8:0A:A9`

`.well-known/assetlinks.json` in this folder already has these exact values filled in — nothing left to edit.

**To finish it — no APK rebuild needed:**

1. Deploy this folder to Netlify (`pixelpro7.netlify.app`) as usual — Netlify serves `.well-known/assetlinks.json` as a normal static file automatically.
2. Confirm it's live: open `https://pixelpro7.netlify.app/.well-known/assetlinks.json` directly in a browser. It must show the raw JSON above, not the app shell or a 404.
3. Reopen the already-installed app on your phone. Android periodically re-checks asset links in the background; if the bar is still there after a minute, force it: **Settings → Apps → Pixel Pro → Storage → Clear cache** (not clear data), then relaunch. If it still hasn't picked it up after that, a full uninstall + reinstall of the same APK guarantees a fresh verification check.
4. The URL bar disappears permanently once verification succeeds — no rebuild, no re-signing, no trip back into PWABuilder required.

Keep `signing.keystore` and `signing-key-info.txt` somewhere safe outside this repo — you'll need that exact key to ever publish an update to this same Play Store/app listing. Never commit or share the keystore itself.


## Cloud sync (Firestore) — REQUIRED for chats/agents to save online

Chats, agents, memory and your display name are stored in Firestore under the
signed-in Google account, so they follow the user across devices and survive a
reinstall. localStorage stays as an instant-read cache and offline fallback.

**One-time setup in the Firebase console (project `pixel-pro-ai-34678`):**

1. Left sidebar → **Build → Firestore Database → Create database**.
2. Choose a location near you (e.g. `asia-south1`) and start in **production mode**.
3. Open the **Rules** tab, replace the contents with this, and press **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

That rule means each signed-in user can read and write only their own document,
and nobody can read anyone else's. Without publishing it, saves are rejected and
the app silently falls back to on-device storage only.

Inline image data URLs are stripped before upload (they would exceed Firestore's
1 MB per-document limit), and history is capped at the 40 most recent chats with
the last 60 messages each.


## Image generation — Stability AI (sole provider)

- `STABILITY_API_KEY` — from https://platform.stability.ai/account/keys
- `STABILITY_MODEL` — optional, defaults to `sd3.5-large-turbo` (fast, high
  quality). Other valid values: `sd3.5-large`, `sd3.5-medium`,
  `sd3-large`, `sd3-large-turbo`, `sd3-medium` — all served from the same
  Stability SD3 endpoint.

Gemini/Imagen has been removed entirely from image generation. If
`STABILITY_API_KEY` is missing, out of credits, or a request fails, the app
falls back to a free keyless generator (Pollinations) so image generation
never dead-ends — but Stability is the only paid/primary provider.


## Haptics (vibration feedback)

No environment variable and no setup.

A short vibration fires when an answer **starts** and a different double-pulse
when it **completes**, plus on send, the feedback icons (like / dislike / copy /
regenerate), model selection, the composer toggles, pinning and deleting a chat,
opening the mic, signing in, and when a generated image or your location is
ready. Each action has its own pattern, so the phone in your pocket tells you
what happened.

Two engines, because the platforms differ:

- **Android** (Chrome, and the wrapped APK, which runs on Chrome) uses the
  Vibration API. Every pattern is at least 18 ms — below roughly 20 ms most
  Android vibration motors round the pulse away to nothing, which is why very
  short "tasteful" buzzes are not subtle but silent.
- **iPhone** has no Vibration API and never has. Since **iOS 17.4** Safari does
  fire the real Taptic Engine when an `<input type="checkbox" switch>` is
  toggled, so that is what runs there. On iOS 17.3 and older there is no way for
  any website to vibrate the phone.

Both platforms refuse feedback until the page has been touched, so the first tap
arms the engine.

**Settings → General → Haptics** shows what is actually happening on that device
and offers a **Test** button that fires straight out of your tap. If Test
produces nothing on an Android phone, the cause is on the device: silent mode,
or system touch-vibration turned off. Haptics also stay silent when the device is
set to reduce motion. The on/off choice is remembered per device (`pp-haptics`).


## Deep search

A toggle inside the composer's **+** menu. No new environment variables — it
reuses `TAVILY_API_KEY` and `GROQ_KEY`.

Ordinary live search is one query, one search, one answer. Deep search instead
runs a research loop **in the browser**, which is the only place it can run: each
round is its own set of requests, so it is never bounded by a serverless
function's timeout.

1. The model plans 8 distinct lines of enquiry.
2. Those run against Tavily, three at a time.
3. The model reads what came back and names the gaps.
4. New queries target only those gaps.
5. Repeat while there is budget and still something worth asking.
6. One long report is written from everything gathered, with numbered citations.

Rounds continue until roughly 1m40 of genuine searching has happened, and stop
by 2m45 at the latest — a typical run is 20-30 searches over 4-7 rounds and takes
two to three minutes end to end. If the model runs out of angles worth chasing it
stops early rather than padding. **Stop generating** cancels the whole loop at any
point.

The report call sets `report: true` on `/chat-stream`, which raises the evidence
window to 90k characters and the reply limit to 8000 tokens. Expect deep search
to use noticeably more Tavily credits and Groq tokens than a normal question —
one run is worth roughly 25 ordinary searches.


## Smart routing — how it decides whether to search

Every question goes through a local router before anything is sent anywhere.
It scores evidence rather than matching the first rule that fires, which is
what the previous version did and why "calculate today's gold rate" could go
straight to the model and answer from stale memory.

Four layers, in order:

1. **Hard rules** — arithmetic, greetings, an explicit "search the web", and
   the facts the device itself holds (time, date, location).
2. **Weighted signals** — evidence for searching (recency words, office-holders,
   prices, weather, sport, releases, versions, schedules, moving statistics,
   Hinglish time words) against evidence for answering directly (maths, code,
   supplied text, creative writing, definitions, settled science, history).
3. **Dampers** — context that weakens a signal: a past year with no recency
   word, "in general", a mechanism question ("how does the stock market work"),
   a definition ("what does GDP mean"), or a request to *write* something about
   a topical subject ("write a poem about the news").
4. **Follow-ups** — a short "and in delhi?" carries no signals of its own, so it
   inherits the previous turn's decision.

Only a clear margin decides locally. Anything genuinely balanced goes to the
model classifier in `/groq` (`mode: "route"`), whose prompt is written for the
hard cases specifically. If that classifier answers "no" with low confidence on
a question the local signals leaned toward searching, the app searches anyway —
a needless search costs a second, a confidently stale answer costs trust.

Measured on a 431-query labelled corpus (five sets, three of them written after
the router was finished and never used to tune it): 417 decided locally with
**0 wrong decisions**. On the sealed set's first run, before any change was made
in response to it, it was 42/43 correct — the single miss was "how many days
until the election", which has since been fixed.


## Photos (the "+" -> Add photo option)

No new environment variable. Photos go to Groq's vision model
(`meta-llama/llama-4-maverick-17b-128e-instruct`), with
`meta-llama/llama-4-scout-17b-16e-instruct` as an automatic fallback when the
first is rate limited, erroring or retired — previously a photo turn had no
second chance at all.

Images are resized client-side to a 1568px long edge and re-encoded as JPEG
under a 3.2 MB budget before they ever leave the phone, which is what keeps a
100 MB camera photo inside the request limits.

## Who built Pixel Pro

The app answers **Mr. Neelaksh Naithani** to any "who made / created / built /
developed / owns you" question. That instruction lives in one constant
(`IDENTITY_LINE`) that is appended to every system prompt — the default one,
each of the three model tiers, and the separate vision prompt on the server —
because a line living only in the default prompt was absent on most paths.

## Landing page

The signed-out landing page has a drifting cloud layer behind the blue wash and
a headline that types out a rotating set of lines ("Precise AI. One assistant.",
"Ask anything. Get real answers.", …), holds each one, then clears it. Two
different haptics fire: a soft confirm when a line lands, a lighter tick when it
clears. Both stay silent until the page has been touched, because no platform
allows vibration before the first interaction.

Everything is transform/opacity only and the headline box is height-locked, so
none of it can move the layout.

## Long press on a chat (phones)

A pointer has no hover, so the pin/share/delete strip that appears beside a chat
on a laptop is unreachable on a phone. Holding a chat for ~0.5s opens an action
sheet with Pin, Rename, Share and Delete. Desktop behaviour is unchanged.


## Pixel Live (voice mode)

No new environment variables — it uses the same Groq, Tavily and Cartesia
keys as the rest of the app.

Voice mode is a strict state machine:

    IDLE -> LISTENING -> USER -> PROCESSING/SEARCHING -> RESPONDING -> LISTENING

Recognition runs in LISTENING and USER only. In every other state it is
**stopped** — not muted, not ignored — which is what makes it impossible for
Pixel to hear its own reply and answer itself. Interrupting is a deliberate
**tap on the orb**, not the microphone: letting speech interrupt speech is
exactly how it used to interrupt itself.

- `continuous:false` — one utterance, one `end` event, one command.
- Every callback carries the session id it was created under and returns early
  if that id is stale, so a late result from a dead engine can never act.
- Commands pass through one door with a lock set synchronously, plus a 2.5s
  duplicate window, so the same utterance cannot be submitted twice.
- Errors back off (400/800/1600ms) and give up after three, with a message.
  A blocked microphone stops immediately rather than retrying.
- A 380ms settle after playback lets the room's reverb die before listening.
- **The orb is a canvas** — ~1450 jittered points on a Fibonacci sphere.
  Neutral when idle, **blue while you speak**, **amber while Pixel speaks**.
- **Two controls only**: end session and mute. The text box is gone.
- **Live-web lookups play a short two-note chime** instead of an orb animation;
  the small "Searching the web…" status text stays.
- **Saying goodbye ends the session** ("bye", "see you", "that's all", …).
  Questions *about* farewells ("what does goodbye mean in french") do not.
- **Every session is saved to Channels** in the sidebar, with a card confirming
  it, and opens again as a readable transcript.

## Tables in answers

Markdown tables are parsed and rendered properly. On a laptop they stay real
tables; below 600px each row becomes a labelled card, because a six-column
comparison squeezed into 360px is unreadable however neatly it is drawn.
`<br>` inside a cell becomes a real break and bullets become a real list.

## Renaming

`window.prompt()` is suppressed inside a Trusted Web Activity, which is why
renaming silently did nothing in the Android app. Both the display name and
chat rename now use an in-app dialog, and the display name updates the sidebar,
the greeting, the settings row and cloud sync together.


## Landing page tap hint

Haptics stay silent until the page has been touched once — no browser on any
platform allows feedback before the first interaction. So the landing page
shows a hand with expanding ripples asking for that first tap, and stops for
good after four (`pp-tap-hint` in localStorage). It never intercepts a tap:
the listener is passive and in the capture phase.

## Mobile composer touch boundaries

Dragging inside the text box used to scroll the whole conversation away — that
is scroll chaining. `overscroll-behavior` only helps when the element *is*
scrollable and hits its end; an empty one-line textarea is never scrollable, so
the gesture went straight to the chat.

`touch-action` is the important part: `pan-y` lets the compositor pan without
waiting for JavaScript, so `preventDefault()` in a touchmove listener arrives
too late. The textarea declares `touch-action: none` and only adds
`.can-scroll` (`pan-y`) once its own content actually overflows.


## Pixel Live memory and search

The orb used to send only `[system, user]` on every turn, so it had no idea
what had just been said — "what year was that" was answered as if it were the
first question ever asked. The session's own turns are now the context, trimmed
to the last ten so a long conversation does not become a long prompt.

Live search uses the same router as the typed composer, with one deliberate
difference: on a genuinely balanced question the orb stays on the fast path
rather than paying for a search, because latency matters more in speech. And
because a search costs a second or two of silence — which reads as a crash —
the orb says a short true line ("Let me look that up") while it runs. The
microphone is already stopped in that state, so the filler cannot be heard as a
question.


## Netlify secrets scanning

The build fails with "Secrets scanning found secrets in build" if any
environment variable's *value* also appears in a repo file. That is correct for
keys and wrong for configuration, so `netlify.toml` lists the non-secret ones
under `SECRETS_SCAN_OMIT_KEYS`: model names, voice ids, audio format, sample
rate, speed, API version, and the two sender addresses. They appear in the code
as defaults so the app still runs if a variable is unset.

`CARTESIA_API_KEY`, `GROQ_KEY`, `TAVILY_API_KEY`, `STABILITY_API_KEY` and
`BREVO_API_KEY` are deliberately **not** in that list — if one of those ever
turns up in a file, the build should keep failing.

## Sentence-pipelined speech

The orb used to wait for the whole reply to be generated, then send it for
synthesis, then wait for that, then play — three serial waits with nothing
audible until all three finished.

Generation and synthesis now overlap. Groq streams tokens; the moment a
complete sentence exists it is sent for synthesis while the rest of the reply
is still being written, and sentence two is fetched while sentence one plays.
Fetches run in parallel, playback is strictly ordered, so a short second
sentence that returns first still waits its turn.

Measured against the test harness: first audio at **765 ms** against a reply
that takes ~2400 ms to finish generating — roughly **1.6 seconds** off
time-to-first-word, and it no longer grows with the length of the answer.

Sentence detection ignores decimals ("3.5"), abbreviations ("e.g.", "Dr.") and
initialisms, and hard-breaks any run of 160 characters with no punctuation so a
chunk cannot grow without bound.


## Going faster still — what changed and what did not

Three more changes squeeze latency without leaving Netlify Functions:

1. **Voice always uses the small Groq model** (`openai/gpt-oss-20b`), regardless
   of the text tier selected. A 1-3 sentence spoken answer does not need the
   120b model's extra depth, and the smaller model starts generating sooner —
   the one delay a voice turn cannot hide behind streaming text on screen.
2. **The audio buffer wait dropped from 900ms/`canplaythrough` to
   450ms/`canplay`.** `canplaythrough` waits for enough data to play the
   *entire* clip without stalling; for a 1-4 second voice clip that is far
   more caution than needed. `canplay` (enough to start smoothly) fires
   meaningfully earlier, and the 900ms guard only existed to bound a slow
   decode, not to be the normal path.
3. **The first sentence of a reply can now start speaking on a comma**, not
   only a full stop. A reply's opening sentence is often its longest — "Fusion
   power is not yet commercially viable, though researchers have made real
   progress" — and waiting for the whole thing before saying a word threw
   away most of what sentence-pipelining bought. Only the first fragment of a
   turn gets this (60+ characters in, breaks on the nearest comma or a plain
   word boundary); every fragment after that still waits for real sentence
   ends, so mid-reply speech does not sound chopped.

What this does **not** touch: the round trip is still browser → Netlify
Function → Cartesia → Netlify Function → browser for every sentence. That
network hop, not model choice or buffering, is the largest remaining cost,
and removing it needs the WebSocket architecture described above — a
long-lived host holding both the Groq stream and the Cartesia socket open at
once, which Netlify Functions structurally cannot do.

## "Sometimes faster, sometimes slower" — the consistency work

The complaint that mattered most was not raw speed but *variance*: the same
question sometimes answered sooner than the old ElevenLabs path and sometimes
later. Three changes address that, and one of them is honestly a hedge.

**1. Every TTS chunk gets one retry.** Previously a failed `/tts` call marked
the chunk `failed` and the queue skipped it — meaning a single transient error
silently dropped a whole sentence from the middle of a spoken answer. A
dropped sentence reads as "it went weird again", and a retried one costs a few
hundred milliseconds. The retry is one attempt only; a second failure still
skips, so a genuinely broken chunk cannot stall the queue.

**2. Short sentences are merged instead of sent separately.**
`SPEAK_MIN_LATER_CHUNK = 130` in `index.html`. After the opening fragment, a
sentence shorter than 130 characters is held back and joined to the next one,
provided there is not already a lot of text waiting. A three-sentence reply
used to mean four Netlify round trips, each an independent chance to hit a
cold container; now it is typically two. The opening fragment is deliberately
exempt — that one is about starting to speak as early as possible, and paying
a round trip for it is the point.

**3. `warmFunctions()` pings `/tts` and `/chat-stream` when the orb starts
listening.** Both functions early-return on `{"warm": true}` without calling
Groq or Cartesia, so the ping costs nothing but a container wake. Be clear
about the status of this one: **a cold-start simulation did not reproduce a
benefit** (1565ms with warm-up vs 1566ms without), because by the time a
question is asked the greeting's own TTS call has already warmed the
container. It is kept because it is free and cannot hurt, not because it is
proven.

## Voice timing readout (Settings → General)

Rather than keep guessing at the cause of the variance, every voice turn now
records where its time actually went, and Settings shows the last eight turns:

    latest  search 412ms · first token 690ms · sent to voice 1180ms · audio ready 1602ms · speaking 1655ms · total 4120ms

- **search** — the live-web lookup finished (a dash means the turn did not search)
- **first token** — Groq's first streamed character arrived
- **sent to voice** — the first speakable chunk was handed to Cartesia
- **audio ready** — the first clip finished downloading and buffering
- **speaking** — playback actually started
- **total** — end of the turn

The gaps between the stages are what matters. A large *first token* gap is
Groq; a large gap between *sent to voice* and *audio ready* is the Cartesia
round trip (and is where a cold container would show up); a large *speaking*
gap after *audio ready* is browser buffering.

Implementation: `turnStart` / `turnMark` / `turnEnd` / `formatTimings` in
`index.html`, persisted to `pp-turn-timings` in `localStorage`, capped at
eight turns. **Copy** puts the whole block on the clipboard (with an
`execCommand` fallback, because clipboard writes are unreliable inside the
TWA); **Clear** empties both memory and storage. The numbers come from the
device that is being slow, not from a mock.

## The big one: the browser now talks to Cartesia directly

Every spoken sentence used to travel:

    browser -> Netlify function -> Cartesia -> Netlify function -> browser

Two of those four legs exist for exactly one reason: to keep `CARTESIA_API_KEY`
off the client. They are not free. Each adds an ocean crossing, and the Netlify
container in the middle can be cold — which made that hop both the largest
slice of the wait and the least predictable one. It is the most likely cause of
"sometimes faster, sometimes slower".

Cartesia's answer is a scoped, short-lived access token. `tts-token.js` is now
the only thing that ever sees the API key; it calls
`POST https://api.cartesia.ai/access-token` with `grants: {tts: true}` and
`expires_in`, and hands the browser a token that can do nothing but synthesise
speech and expires in ten minutes. The browser then calls
`https://api.cartesia.ai/tts/bytes` itself:

    browser -> Cartesia -> browser

**The rule that makes this safe to ship:** the direct path is used *only when a
valid token is already in hand*. It is never waited for. If no token has
arrived yet, or the direct call fails for any reason — CORS, an expired token,
a network blip — the sentence goes down the old proxy path immediately, and the
session stops attempting the direct one (`ttsDirect = 'off'`, sticky). Worst
case this change does nothing at all; it cannot make a turn slower than it was.

Tokens are minted at two points, both chosen so nobody is ever waiting on one:
`openLive()` (so even the greeting has a chance at the fast path) and
`warmFunctions()` on entering LISTENING. The mint in `warmFunctions` sits
**above** the 8-second throttle, deliberately: a warm container does not imply a
fresh token, and the greeting's own synthesis leaves `lastFnCallAt` recent
enough that everything below that line is skipped — which would have meant no
token existed until a sentence needed one, defeating the entire point.

Two smaller wins ride along:

- **Blob URLs instead of base64 data URIs.** The proxy path base64-encodes the
  audio on the server and the phone decodes it back. Going direct means raw
  bytes into a `Blob` — no encode, no decode, ~33% fewer bytes on the wire.
  Blob URLs are revoked on `ended` and on `error` so nothing leaks.
- **Markdown stripping moved client-side** (`ttsCleanText`), mirroring what the
  proxy did server-side, so the voice does not read asterisks and pipes aloud.

The Voice timing readout now tags each row `[direct]` or `[proxy]`, so it is
visible at a glance which path a turn actually took.

### Security note

A leaked token buys a few minutes of text-to-speech and nothing else: no
account access, no key, no other Cartesia capability. `tts-token` sets
`Cache-Control: no-store`, and `/.netlify/functions/` was already in the
service worker's `NEVER_CACHE` list (`api.cartesia.ai` is now listed too,
though the cross-origin guard already covered it). Set `CARTESIA_TOKEN_TTL` to
change the lifetime; it is in `SECRETS_SCAN_OMIT_KEYS` alongside the other
non-secret Cartesia config.

### If the direct path never engages

Check the Voice timing rows. If every row says `[proxy]`, either the token
endpoint is failing (open `/.netlify/functions/tts-token` — it returns
Cartesia's own error text) or Cartesia is refusing the browser's origin, in
which case the fallback is doing its job and voice still works.

## The listening phase — not waiting for Chrome to make up its mind

The slowest part of a spoken turn was never Groq and never Cartesia. It was
waiting for the browser to decide the user had stopped talking. Chrome's
endpointer sits on a finished sentence for a second or more before marking the
result `isFinal`, and that second is dead silence to the person who just spoke.
On top of it, `LIVE_FINAL_GRACE_MS` then waited another 1100ms in case `onend`
never fired. Worst case that was over two seconds of nothing, after the
sentence was already fully transcribed.

**The fix is to watch the interim transcript instead of waiting for the final.**
When the interim stops changing, the speaking has stopped — we do not need the
browser to agree. `interimHoldMs(text)` decides how long to wait:

| Situation | Hold | Why |
|---|---|---|
| A phrase that sounds finished ("what is the capital of France") | `VOICE_HOLD_MS` 620ms | Long enough to be a real pause, short enough not to be felt |
| Three words or fewer ("play music", "hello") | `VOICE_HOLD_SHORT_MS` 950ms | A short phrase is often the start of a longer one |
| Ends on a word that cannot end a sentence ("what is the", "…and", "…um") | `-1` — never commit early | The speaker is clearly mid-thought |

Every new interim **rearms** the timer, so it fires only once the words have
genuinely stopped. If the guards say `-1`, nothing changes from before: the
browser's own final commits the turn exactly as it used to.

**Why committing early is safe.** `recCommit` is idempotent. The browser's real
final arrives a second later, matches `lastCommand` inside `LIVE_DUP_MS`, and is
dropped. There is no path where a sentence is asked twice — that is asserted
directly ("the browser's late final does not ask again").

`LIVE_FINAL_GRACE_MS` also drops from 1100ms to **250ms**. Once a final exists,
`onend` normally follows within a couple of hundred milliseconds, and the dedup
makes an early commit free.

Expected saving: roughly **0.7–1.5 seconds on every single spoken turn**, which
is larger than everything the TTS work bought combined.

## What was cut from the Groq prompt, and what deliberately was not

`voiceSystemPrompt()` replaces `systemPrompt()` on the voice path. The full app
prompt is ~1,900 characters, most of it instructions a spoken answer cannot use:
markdown, bullets, headings, emoji, citation markup, paragraph counts. Voice
then appended ~370 more characters on top of that. The spoken version is ~730
characters and keeps only what matters — identity (including the "who created
you" line), language, spoken length, live-context handling, conversational
continuity, and the user's saved memory.

**The conversation history was deliberately left alone at ten turns / 700
characters.** Trimming it was tempting and I tried it, but Groq's prefill runs
at thousands of tokens per second, so the entire history costs on the order of a
millisecond. Cutting it would have traded away the orb's memory — which was
asked for outright — in exchange for nothing measurable. Redundant instructions
were the right thing to cut. The conversation is not.

Be honest about the size of this one: the prompt trim is worth tens of
milliseconds at best. The listening fix above is worth a hundred times more.

## Reading the timing rows now

    latest  [direct] listen 840ms · search — · first token 310ms · sent to voice 520ms · audio ready 760ms · speaking 775ms · total 3100ms

`listen` is new and comes first: the time from the first word heard to the
moment the utterance was accepted. It is measured in `recCommit` from
`live.heardAt`, and carried into the turn record by `turnStart`. If that number
is large, the endpointing guards are being conservative — a phrase ending on a
word in `VOICE_INCOMPLETE_TAIL` falls back to the browser's own final, which is
the slow path by design.

## Read Aloud — the same pipeline the orb uses

Read Aloud was the slowest voice path in the app, and for a structural reason:
`speak(reply)` was called *after* the stream finished. On a six-sentence answer
that meant waiting for the entire generation, then one TTS call for the whole
text, then playback. Two silences back to back.

It now uses `makeSpeechQueue` — the same sentence pipeline as the voice orb —
so the first sentence is synthesised and played while the rest is still being
written. Measured against the mock (a ~2.3s answer): **first audio at ~840ms
instead of after the full 2.3s plus synthesis.**

Making that reuse possible took two small changes to the queue rather than a
copy of it:

- `opts.isStale` — the orb invalidates its turns with `live.sessionId`; a chat
  turn has its own notion of being superseded (`chatSpeechId`), so it supplies
  its own test.
- `opts.orb: false` — skips the three orb-only side effects at first audio
  (`liveStopSpeaking`, `liveGo('responding')`, `haptic('start')`).

`startChatSpeech()` opens a reading, `feed(full)` gets every delta from the
stream, `end(reply)` flushes the tail. `stopChatSpeech()` is wired to the Stop
button and to switching Read Aloud off, so both silence what is already queued
rather than only what is currently playing.

Read Aloud also inherits the direct-to-Cartesia path automatically, since it
goes through the same `ttsClip`.

A photo turn never streams, so it has nothing queued and falls back to the old
whole-answer `speak(reply)`. That path is kept for exactly this reason.

## Two smaller speed changes

**Groq warm-up on typing.** Typing is several seconds of notice that a request
is coming. `warmForTyping()` fires on focus and on input, waking `/chat-stream`,
`/groq` and `/tts` and minting the Cartesia token. It is throttled by
`lastFnCallAt`, so a long message pings once rather than once per keystroke.
`groq.js` gained the same `{"warm": true}` early return the other two already
had. This removes the cold container from the typed path; it does not make a
warm request any faster.

**The audio fade starts audible.** The fade at the start of each clip exists to
stop a click at the boundary, not to be heard — but starting from zero meant the
first syllable arrived under a ramp and read as lateness. It now starts at 0.45
and reaches full level in ~40ms instead of 63. A 0.45 floor is already far below
the discontinuity that causes a click, so this is prompter onset at identical
quality.

Both are small. Said plainly: the warm-up matters only on a cold container, and
the fade change is perceptual rather than measured latency.

## Mobile composer — pulled down, and displaced on tap

Two separate bugs, two separate causes.

**1. The composer could be dragged downward.** Two things allowed it:

- `.composer-wrap` was `position: sticky; bottom: 0`, but it is a flex *sibling*
  of `<main>`, not a child of it. The column layout already pins it to the
  bottom, so `sticky` bought nothing — it only added a second, viewport-relative
  positioning mode for the browser to move it with. It is now `relative`.
- `#main` had `overscroll-behavior: contain`. `contain` stops a bounce
  *propagating* to the page but still permits the scroller its own rubber-band,
  and that local bounce is what dragged the whole column down. It is now `none`,
  as are `html, body` and `.composer-wrap`.

**2. The box appeared in the wrong place when tapped.** When a field is focused,
mobile Safari brings it into view by scrolling the *layout* viewport — the
document slides up behind the keyboard. That is right for an ordinary page and
wrong for this one: the app is already sized to the visual viewport (`--vvh`),
so the composer is above the keyboard before Safari does anything. Its scroll is
pure displacement.

`unscrollDocument()` undoes it. The document has `overflow: hidden` and nowhere
to go, so any non-zero `pageYOffset` is the browser having moved something we
did not ask it to. It runs on `focusin` (immediately, then at 60ms and 300ms,
after the keyboard animation settles), on `focusout`, on every visual-viewport
resize/scroll, and on any stray `scroll` event.

Both are covered by `box.py`: a hard 240px downward drag starting on the
composer, asserted mid-drag and after; tap-to-focus; a stray `scrollTo(0,180)`;
and the keyboard-up case.

## Per-chat URLs

Every conversation has its own address, `/c/<id>` — the same shape ChatGPT
uses. Opening a chat puts that address in the bar, loading that address opens
the chat, and Back/Forward walk the conversations you have looked at.

**Be clear about what these links are: they are private.** A chat lives in this
browser's storage and in the signed-in account's own Firestore data, so the URL
opens it *for you, on your devices*. Sending it to someone else shows them
nothing. That is exactly how ChatGPT's own `/c/` links behave — sharing a
conversation there is a separate, explicit action. Pixel Pro's Share button,
which sends the transcript itself, remains the way to show a chat to someone
else.

Ids are the existing `'c' + timestamp + 4 random chars`. They were already
unique and URL-safe, so nothing about stored chats changed.

### Serving it

`netlify.toml` rewrites `/c/*` to `/index.html` with status 200. It is
deliberately scoped to `/c/*` rather than a catch-all `/*`: a blanket SPA
fallback would swallow genuine 404s and could shadow `/.netlify/functions/*` if
rule ordering ever changed. The service worker needed no change — its navigate
branch already falls back to the cached `/index.html`, which is the right
response for any `/c/<id>`.

One thing that had to be verified rather than assumed: every asset reference in
`index.html` is root-absolute (`/manifest.json`, `/icons/...`, `/sw.js`). A
relative one would resolve against `/c/` and 404 — or worse, match the rewrite
and be served the HTML page instead.

### Resolving an address is a race, not an event

Three things can supply the chat named in the URL, and they finish in an order
that varies: the synchronous boot pass, auth resolving, and the cloud chats
arriving. `resolveChatUrl()` can be called from all three; `urlChatSettled`
makes the losers no-ops. The cloud call is what makes "open my chat link on my
other device" work — until that sync lands, the device has genuinely never seen
the conversation.

`giveUpOnChatUrl()` is the last word, on an 8-second deadline matching the
existing boot safety net. Only then is an address declared missing, the toast
shown, and the URL cleaned. Reporting earlier would be wrong, and clearing the
URL earlier would destroy the id the cloud pass still needs.

**Two rules keep history sane**, both of which are the usual way SPA routing
gets broken:

- Navigating *because of* a popstate must never push a new entry (`routingBack`
  suppresses `setChatUrl`), or Back becomes impossible to escape.
- Opening the chat already in the address bar replaces rather than pushes, so a
  reload does not stack duplicate entries.

### An address outranks "resume where you left off"

This one was found by a test rather than by reading the code. The boot sequence
already reopened the last in-progress conversation, and it ran after the URL
pass — so opening `/c/<id>` for a chat not yet loaded would drop the user into a
*different* conversation and overwrite the address, destroying the id before the
cloud copy could arrive. `resumeActiveChat()` is now skipped entirely whenever
the path names a chat, found or not.

Signing in or out also clears the address, since it changes whose chats these
are.
