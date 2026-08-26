// Pixel Pro — Cartesia Sonic TTS backend (Netlify Function).
//
// WHY HTTP AND NOT THE WEBSOCKET
//
// Cartesia's lowest-latency path is wss://api.cartesia.ai/tts/websocket, fed
// token-by-token from the LLM stream. That needs a process that stays alive
// holding two sockets open at once. Netlify Functions are request/response and
// are torn down when the response ends, so there is nowhere for that process
// to live. The browser could hold the socket itself, but only by being handed
// the Cartesia key, which would publish it to every visitor.
//
// So this uses /tts/bytes, which is one round trip. Sonic's time-to-first-byte
// is tens of milliseconds, so nearly all of the WebSocket's advantage is kept;
// what is lost is overlapping synthesis with generation, which is worth roughly
// one sentence of latency on a long reply. Moving to the socket means moving
// off Netlify Functions to something long-lived (Fly, Render, a Cloudflare
// Durable Object) — see deploy-guide.md.
//
// Everything below is env-driven, so the model and voice can change without a
// code change, and Cartesia's own error text is passed through verbatim rather
// than being flattened into "voice unavailable".

const CARTESIA_URL = 'https://api.cartesia.ai/tts/bytes';
const CARTESIA_VERSION = process.env.CARTESIA_VERSION || '2024-06-10';
const DEFAULT_MODEL = 'sonic-3.6';
// "Skyler" from the base library.
const DEFAULT_VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';

function cleanText(text){
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*`>_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

function getVoiceId(gender){
  if (gender === 'female') return process.env.CARTESIA_VOICE_ID_FEMALE || process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE;
  if (gender === 'male')   return process.env.CARTESIA_VOICE_ID_MALE   || process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE;
  return process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE;
}

// wav/pcm_s16le is the default because it is genuinely uncompressed — the
// encoder does no work at all, which is the point of asking for raw PCM — and
// a WAV header is the one container <audio> plays natively without a decode
// step. Set CARTESIA_FORMAT=mp3 if the wire cost matters more than the encode
// cost, which it does on a slow mobile connection: WAV is roughly ten times
// the bytes of a 64kbps MP3 of the same speech.
function outputFormat(){
  const fmt = (process.env.CARTESIA_FORMAT || 'wav').toLowerCase();
  const rate = parseInt(process.env.CARTESIA_SAMPLE_RATE || '16000', 10) || 16000;
  if (fmt === 'mp3') {
    return {
      body: { container: 'mp3', sample_rate: rate === 16000 ? 44100 : rate, bit_rate: 64000 },
      mime: 'audio/mpeg',
    };
  }
  return {
    body: { container: 'wav', encoding: 'pcm_s16le', sample_rate: rate },
    mime: 'audio/wav',
  };
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Use POST.' }) };

  const KEY = process.env.CARTESIA_API_KEY;
  if (!KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'CARTESIA_API_KEY not set in Netlify environment variables.' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON.' }) }; }

  const text = cleanText(payload.text);
  if (!text) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No text to speak.' }) };

  const model = process.env.CARTESIA_MODEL || DEFAULT_MODEL;
  const voiceId = getVoiceId(payload.gender);
  const fmt = outputFormat();

  const body = {
    model_id: model,
    transcript: text,
    voice: { mode: 'id', id: voiceId },
    output_format: fmt.body,
    language: payload.lang === 'hi' ? 'hi' : payload.lang === 'bn' ? 'bn' : 'en',
  };
  const speed = parseFloat(process.env.CARTESIA_SPEED || '');
  if (!isNaN(speed)) body.speed = speed;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(CARTESIA_URL, {
      method: 'POST',
      headers: {
        // Cartesia has accepted both over the life of the API; sending both
        // costs nothing and survives whichever one the account is on.
        'X-API-Key': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!r.ok) {
      // Pass Cartesia's own words through. A wrong model id or an unknown
      // voice is a five-second fix if you can read the message, and an
      // afternoon if all you get is "voice unavailable".
      let msg = 'Cartesia request failed (HTTP ' + r.status + ').';
      try {
        const t = await r.text();
        try { const j = JSON.parse(t); msg = j.error || j.message || (j.errors && j.errors[0]) || msg; }
        catch (_) { if (t) msg = t.slice(0, 300); }
      } catch (_) {}
      return {
        statusCode: r.status,
        headers: CORS,
        body: JSON.stringify({ error: msg, stage: 'cartesia', model, voiceId }),
      };
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Empty audio from Cartesia.' }) };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        audio: buf.toString('base64'),
        mime: fmt.mime,
        provider: 'cartesia',
        model,
      }),
    };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: timedOut ? 'Cartesia took too long.' : 'Upstream Cartesia error.', stage: 'network' }),
    };
  } finally {
    clearTimeout(timer);
  }
};
