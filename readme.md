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
