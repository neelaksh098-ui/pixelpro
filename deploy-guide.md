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
- `ELEVENLABS_API_KEY` — your ElevenLabs API key
- `ELEVENLABS_VOICE_ID` — your default ElevenLabs voice ID
- `ELEVENLABS_VOICE_ID_MALE` — optional male voice ID (overrides the default for male)
- `ELEVENLABS_VOICE_ID_FEMALE` — optional female voice ID (overrides the default for female)
- `ELEVENLABS_MODEL_ID` — optional, defaults to `eleven_flash_v2_5`
- `ELEVENLABS_OUTPUT_FORMAT` — optional, defaults to `mp3_44100_128`

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

Pixel Pro uses ElevenLabs for spoken responses, including the Pixel Live voice orb and normal chat speech. Voice input still uses the browser Web Speech API when available, and the Live screen also includes a text command box so commands can be typed instead of spoken.

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
