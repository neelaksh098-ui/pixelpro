// Pixel Pro — ElevenLabs TTS backend (Netlify Function)
// API key and voice IDs stay server-side in Netlify environment variables.

function cleanText(text){
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[#*`>_~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

function getVoiceId(gender){
  if(gender === 'female') return process.env.ELEVENLABS_VOICE_ID_FEMALE || process.env.ELEVENLABS_VOICE_ID || '';
  return process.env.ELEVENLABS_VOICE_ID_MALE || process.env.ELEVENLABS_VOICE_ID || '';
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if(event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Use POST.' }) };

  const KEY = process.env.ELEVENLABS_API_KEY;
  if(!KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ELEVENLABS_API_KEY not set in Netlify environment variables.' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON.' }) };
  }

  const text = cleanText(payload.text || '');
  if(!text) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No text provided.' }) };

  const gender = payload.gender === 'female' ? 'female' : 'male';
  const voiceId = getVoiceId(gender);
  if(!voiceId) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Set ELEVENLABS_VOICE_ID or a gender-specific ElevenLabs voice ID in Netlify.' }) };

  const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
  const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
  const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=' + encodeURIComponent(outputFormat);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': KEY,
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: modelId }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if(!r.ok){
      const raw = await r.text();
      let msg = 'ElevenLabs TTS failed.';
      try {
        const d = JSON.parse(raw);
        msg = d.detail && d.detail.message ? d.detail.message : (d.message || msg);
      } catch(e) {
        if(raw) msg = raw.slice(0, 300);
      }
      return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: msg }) };
    }

    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        audio: buf.toString('base64'),
        voiceId,
        modelId,
        outputFormat,
      }),
    };
  } catch(e) {
    const timedOut = e && e.name === 'AbortError';
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: timedOut ? 'ElevenLabs TTS timed out.' : 'TTS error: ' + (e && e.message ? e.message : 'unknown') }),
    };
  }
};
