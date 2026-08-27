// Pixel Pro — mints a short-lived Cartesia access token for the browser.
//
// WHY THIS EXISTS
//
// Every spoken sentence used to travel browser -> Netlify -> Cartesia ->
// Netlify -> browser. Two of those four legs exist only to keep the API key
// off the client, and they cost real time: an extra ocean crossing each way
// plus a Netlify container that may be cold. On a bad turn that hop was the
// single largest and least predictable slice of the wait.
//
// Cartesia's answer to this is a scoped, short-lived access token. This
// function is the only thing that ever sees CARTESIA_API_KEY; it hands back a
// token that can do nothing but synthesise speech and expires in minutes. The
// browser then talks to Cartesia directly — one leg instead of three.
//
// The token is deliberately narrow and short-lived: if one leaks out of a
// browser it buys the holder a few minutes of text-to-speech and no access to
// the account, the key, or any other Cartesia capability.

const TOKEN_URL = 'https://api.cartesia.ai/access-token';
const CARTESIA_VERSION = process.env.CARTESIA_VERSION || '2024-06-10';
const DEFAULT_MODEL = 'sonic-3.6';
const DEFAULT_VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';

// Ten minutes. Long enough that a normal voice session never refreshes
// mid-conversation, short enough that a leaked token is close to worthless.
const TTL_SECONDS = parseInt(process.env.CARTESIA_TOKEN_TTL || '600', 10) || 600;

function getVoiceId(gender){
  if (gender === 'female') return process.env.CARTESIA_VOICE_ID_FEMALE || process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE;
  if (gender === 'male')   return process.env.CARTESIA_VOICE_ID_MALE   || process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE;
  return process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE;
}

function outputFormat(){
  const fmt = (process.env.CARTESIA_FORMAT || 'wav').toLowerCase();
  const rate = parseInt(process.env.CARTESIA_SAMPLE_RATE || '16000', 10) || 16000;
  if (fmt === 'mp3') {
    return { body: { container: 'mp3', sample_rate: rate === 16000 ? 44100 : rate, bit_rate: 64000 }, mime: 'audio/mpeg' };
  }
  return { body: { container: 'wav', encoding: 'pcm_s16le', sample_rate: rate }, mime: 'audio/wav' };
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    // A token this short-lived must never sit in a CDN or a service worker.
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Use POST.' }) };

  const KEY = process.env.CARTESIA_API_KEY;
  if (!KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'CARTESIA_API_KEY not set in Netlify environment variables.' }) };

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch (_) {}

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      // tts only. No stt, no voice management, no account access.
      body: JSON.stringify({ grants: { tts: true }, expires_in: TTL_SECONDS }),
      signal: ctrl.signal,
    });

    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch (_) {}

    if (!r.ok) {
      const msg = data.error || data.message || (data.errors && data.errors[0]) || text.slice(0, 300) ||
                  ('Cartesia token request failed (HTTP ' + r.status + ').');
      return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: msg, stage: 'cartesia-token' }) };
    }

    // Cartesia has used more than one field name for this over the life of
    // the API. Accept any of them rather than break on a rename.
    const token = data.token || data.access_token || data.accessToken || data.jwt;
    if (!token) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Cartesia returned no token.', stage: 'cartesia-token' }) };
    }

    const fmt = outputFormat();
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        token,
        // Absolute wall-clock expiry, so the client does not have to trust
        // its own idea of when it made the request.
        expiresAt: Date.now() + TTL_SECONDS * 1000,
        version: CARTESIA_VERSION,
        model: process.env.CARTESIA_MODEL || DEFAULT_MODEL,
        voiceId: getVoiceId(payload.gender),
        outputFormat: fmt.body,
        mime: fmt.mime,
        speed: isNaN(parseFloat(process.env.CARTESIA_SPEED || '')) ? null : parseFloat(process.env.CARTESIA_SPEED),
      }),
    };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: timedOut ? 'Cartesia token request took too long.' : 'Could not reach Cartesia.', stage: 'network' }),
    };
  } finally {
    clearTimeout(timer);
  }
};
