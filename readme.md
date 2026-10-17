# Pixel Pro AI Android TWA

Android Trusted Web Activity wrapper for `https://pixelpro7.netlify.app`.

## Package name

`app.netlify.pixelpro7.twa` — do not change this value because Digital Asset Links and release signing depend on it.

## Release signing

Create a keystore and provide signing values through environment variables or matching Gradle properties:

```bash
keytool -genkeypair -v -keystore pixelpro-release.jks -alias pixelpro-release -keyalg RSA -keysize 2048 -validity 10000
export PIXELPRO_RELEASE_STORE_FILE=/absolute/path/to/pixelpro-release.jks
export PIXELPRO_RELEASE_STORE_PASSWORD='...'
export PIXELPRO_RELEASE_KEY_ALIAS=pixelpro-release
export PIXELPRO_RELEASE_KEY_PASSWORD='...'
gradle :app:assembleRelease
```

After generating the release certificate, publish the SHA-256 fingerprint in `https://pixelpro7.netlify.app/.well-known/assetlinks.json` for package `app.netlify.pixelpro7.twa`.


## Web AI architecture

- Groq handles fast everyday chat and image questions.
- Tavily Search handles current/live web questions.
- The previous Google AI and legacy client-side search paths are no longer used by the web app.
- Set `GROQ_KEY`, `EXA_API_KEY` and `TAVILY_API_KEY` in Netlify environment variables.
  (Exa is the primary live-web provider; Tavily is the fallback and the deep-research provider.)

## Voice architecture

- Cartesia Sonic handles TTS for normal chat and the Pixel Live voice orb.
- The default voice model is `sonic-3.6`; set `CARTESIA_MODEL` to override it.
- Browser Web Speech API remains the input method for the microphone/orb.
- Pixel Live includes a text command box as an alternative to speaking.

## Asking Pixel Pro to do things

Every feature that has a button can also be asked for, in chat or by voice,
in plain words — and several can be asked for in one message. Steps run in
the order they were asked for.

| Ask for | For example |
|---|---|
| a picture | "I want a dog playing picture", "draw a cat in a hat", "ek kutte ki photo banao" |
| the theme | "dark mode", "set theme to light", "theme dark kar do", "change the theme" |
| the glass design | "turn off the glass design", "liquid glass on", "I don't want liquid glass" |
| your location | "where am I", "tell me my location", "turn off location" |
| email | "email me this", "write an email to my boss asking for leave" |
| the voice | "switch to female voice" |
| read aloud | "turn on read aloud", "stop reading the answers aloud" |
| modes | "turn on deep research", "turn off think mode", "turn on web search" |
| the app | "new chat", "open voice mode", "open settings" |
| memory | "remember that my exam is on 12 November", "what do you remember about me", "forget everything" |

Mixed: "what is 2+2, also tell me my location, and make an image" — answers
the question, finds the location, then draws a picture of where you are
(and says so, since no subject was given). With nothing to infer from, it
asks what to draw and treats your reply as the subject.

How it decides: a local parser reads clear commands with no network call; a
model planner is consulted only when a message plainly wants something done
but the rules cannot read it (another language, unusual phrasing). A message
that asks for nothing takes the ordinary path untouched, at no extra cost.
Questions that merely mention a feature — "what is dark mode", "what is the
theme of Hamlet" — stay questions.

Email to other people is drafted, never sent automatically: the draft comes
with a one-tap "Open in Gmail", filled in.

Tests: `tests/actiontest.py` (94 phrasings plus end-to-end runs in chat and
voice) alongside `tests/orbtest.py`.

## Liquid Glass design (every device)

Pixel Pro uses an iOS 26-style Liquid Glass design on every device: iPhone,
iPad, Android, Mac, Windows and Linux, in every browser.

- **Glass over the chat.** The conversation scrolls under a floating glass
  composer and floating glass header buttons; the header and the strip under
  the composer fade into the page instead of being solid bars. Menus, the
  chats sidebar (a floating rounded panel on phones), the account menu, the
  voice orb's buttons, cards, chips and the Settings / Library / Agents
  navigation bar are all the same glass. The page background is unchanged:
  white, or pure black in dark theme.
- **Bouncy taps.** Every control squashes under a finger, lights up where it
  was touched, and springs back past full size before settling, like iOS.
  Round buttons give the most, chips less, whole rows only slightly. Mouse
  clicks and Enter/Space do the same; with Reduce Motion on, the light still
  answers but nothing moves.
- **Compose button.** A glass square-and-pencil button at the top right
  starts a new chat, as in iOS Notes (on a laptop it leaves a docked sidebar
  open). The sidebar's New Chat uses the same icon.
- **Apple's typeface on Apple devices.** iPhone, iPad and Mac show SF Pro;
  everything else keeps Inter.
- **The material, measured.** Values were taken pixel by pixel from
  Apple-style glass (the Solid Glass reference icons). Dark glass is matte:
  a flat face with no gloss. The light lives in a 1px rim, brightest facing
  the light, softer at the opposite corner and faint between, with a faint
  glow along the inside bottom edge. Light glass is white with a breath of
  shading toward the bottom.
- **Reflections that move.** Tilt the phone and the highlight slides round
  every rim while a faint glint drifts across the faces, as on iOS 26. It
  follows changes in tilt (the resting point re-centres on however you hold
  the phone) and handles landscape. On iPhone and iPad, Safari asks for
  motion access the first time you tap a glass button (never at load, never
  from the text box); a "no" is remembered. Android needs no permission. On
  a computer the light leans toward the mouse. Settings → General →
  "Reflections follow motion" turns it off; Reduce Motion keeps it still.

Switching it:

| How | What it does |
|---|---|
| Settings → General → Glass design | Turn off / Turn on, on this device |
| Say or type "turn off the glass design" / "liquid glass on" | the same, from chat or voice |
| `?glass=0` on the address | turn it off |
| `?glass=1` or `?glass=auto` | turn it back on |

Turned off, the app is exactly the earlier flat design (checked pixel for
pixel against the last flat-only build). With "Increase Contrast" on, or in a
browser too old to blur, the glass turns solid. The lens-like refraction at
the edges of Apple's own glass cannot be done in Safari (it needs an SVG
filter Safari does not support), so it is not attempted; the blur, the colour
through the glass, the lit rim and the fading edges are.

Tests: `tests/glasstest.py` — every device gets it, it really blurs, the chat
really runs under the bars and the newest reply still lands above the
composer, the press-and-spring is measured mid-bounce, the dark face has no
gloss, the rim is brightest toward the light and the bright spot moves when
the phone tilts (read from screenshot pixels), the iPhone permission is asked
only inside a tap, the light follows the mouse on a laptop, the compose button,
the switches, and glass-off screenshots of Android and a laptop compared
pixel for pixel with a flat build (`PP_BASELINE=934c528` for the last
flat-only one).

## Site structure: launch site + app

| Path | What it is |
|---|---|
| `/` | The Pixel Pro app (`index.html`). Unchanged location, so the Android app, `/c/<chat>` links and installed PWAs keep working. |
| `/welcome/` | The launch site — the front door for anyone not signed in. One simple page (`index.html` + `css/site.css`, one photo in `media/`, its own service worker). No intro, film, music, narration or ElevenLabs; nothing animates by itself. |

How a visitor moves between them:

- **Never signed in on this device** → opening `/` goes to `/welcome/` before
  the app draws anything (a check in the app's `<head>`).
- **"Try Pixel Pro"** on the launch site → `/?signin=1`, which opens the app
  straight to its sign-in screen.
- **Closing sign-in without signing in** → back to `/welcome/`.
- **Signed in** → `/` opens straight into the app, every time.
- **Signing out**, or a session that has expired → back to `/welcome/`.

Every "Try Pixel Pro" button on the launch site is a plain link to
`/?signin=1` (marked `data-app`) in `welcome/index.html`.

Two service workers share the origin: the app's (`/sw.js`, scope `/`) and
the launch site's (`/welcome/sw.js`, scope `/welcome/`). The app's worker
never handles `/welcome/` requests, saves only app pages as its offline copy,
and on update deletes only its own `pixelpro-v*` caches — so neither can
damage the other. `node tests/swtest.js` checks all three.

Tests for the whole journey: `tests/sitetest.py`.
