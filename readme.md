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
| the glass design | "turn off the glass design", "liquid glass on" |
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

## Liquid Glass on iPhone and iPad

iPhones and iPads get an iOS 26-style Liquid Glass design automatically;
every other device (Android, Windows, Mac, Linux) keeps the normal design,
pixel for pixel. Every browser on an iPhone counts (Safari, Chrome, Firefox,
Edge), and so does an iPad, even though iPadOS says it is a Mac.

What changes on those devices: the chat scrolls under a floating glass
composer and floating glass header buttons, the header and the strip under
the composer fade into the page instead of being solid bars, and the + menu,
the account menu, the chats sidebar, the voice orb's buttons and the sign-in
and confirm cards are glass too. The page background stays as it was (white,
or pure black in dark theme).

Switching it:

| How | What it does |
|---|---|
| Settings → General → Glass design | Turn off / Turn on, on this device |
| Say or type "turn off the glass design" / "liquid glass on" | the same, from chat or voice |
| `?glass=1` on the address | preview it on any device, e.g. a laptop |
| `?glass=0` | turn it off |
| `?glass=auto` | back to automatic (on for iPhone/iPad only) |

With iOS "Increase Contrast" on, the glass turns solid. The lens-like
refraction at the edges of Apple's own glass cannot be done in Safari (it
needs an SVG filter Safari does not support), so it is not attempted; the
blur, the colour through the glass, the lit rim and the fading edges are.

Tests: `tests/glasstest.py` — which devices get it, that it really blurs,
that the chat really runs under the bars and the newest reply still lands
above the composer, the switches, and screenshots of Android and a laptop
compared pixel for pixel against the previous build.

## Site structure: launch site + app

| Path | What it is |
|---|---|
| `/` | The Pixel Pro app (`index.html`). Unchanged location, so the Android app, `/c/<chat>` links and installed PWAs keep working. |
| `/welcome/` | The launch site — the front door for anyone not signed in. Its own `css/`, `js/`, `media/` and service worker. |

How a visitor moves between them:

- **Never signed in on this device** → opening `/` goes to `/welcome/` before
  the app draws anything (a check in the app's `<head>`).
- **"Try Pixel Pro"** on the launch site → `/?signin=1`, which opens the app
  straight to its sign-in screen.
- **Closing sign-in without signing in** → back to `/welcome/`.
- **Signed in** → `/` opens straight into the app, every time.
- **Signing out**, or a session that has expired → back to `/welcome/`.

The launch site's button target is `CONFIG.appUrl` near the top of the
script in `welcome/index.html`.

Two service workers share the origin: the app's (`/sw.js`, scope `/`) and
the launch site's (`/welcome/sw.js`, scope `/welcome/`). The app's worker
never handles `/welcome/` requests, saves only app pages as its offline copy,
and on update deletes only its own `pixelpro-v*` caches — so neither can
damage the other. `node tests/swtest.js` checks all three.

Tests for the whole journey: `tests/sitetest.py`.
