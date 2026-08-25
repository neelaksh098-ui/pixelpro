// Pixel Pro — Stability AI image generation (sole image provider).
// Set STABILITY_API_KEY in Netlify. Uses the SD3 endpoint with model
// "sd3.5-large-turbo" by default — fast, high quality. Override with
// STABILITY_MODEL if you ever want sd3.5-large, sd3.5-medium, etc.
const SD3_URL = "https://api.stability.ai/v2beta/stable-image/generate/sd3";
const DEFAULT_MODEL = "sd3.5-large-turbo";

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Use POST." }) };

  const KEY = process.env.STABILITY_API_KEY;
  if (!KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "STABILITY_API_KEY not set in Netlify environment variables.", stage: "config" }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad JSON." }) }; }

  const prompt = String(payload.prompt || "").trim().slice(0, 1800);
  if (!prompt) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No prompt." }) };

  const model = (process.env.STABILITY_MODEL || DEFAULT_MODEL).toLowerCase();
  const aspect = String(payload.aspectRatio || "1:1");
  // sd3.5-large-turbo does not accept a negative_prompt or cfg_scale.
  const isTurbo = model.indexOf("turbo") !== -1;

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("model", model);
  form.append("output_format", "webp");
  form.append("aspect_ratio", aspect);
  form.append("mode", "text-to-image");
  if (!isTurbo && payload.negativePrompt) form.append("negative_prompt", String(payload.negativePrompt).slice(0, 800));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const r = await fetch(SD3_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + KEY, Accept: "image/*" },
      body: form,
      signal: ctrl.signal,
    });

    if (!r.ok) {
      let msg = "Stability request failed (HTTP " + r.status + ").";
      try {
        const t = await r.text();
        try { const j = JSON.parse(t); msg = (j.errors && j.errors[0]) || j.message || j.name || msg; }
        catch (_) { if (t) msg = t.slice(0, 300); }
      } catch (_) {}
      return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: msg, stage: "stability" }) };
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Empty image from Stability." }) };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ dataUrl: "data:image/webp;base64," + buf.toString("base64"), provider: "stability", model }),
    };
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: timedOut ? "Stability took too long." : "Upstream Stability error.", stage: "network" }) };
  } finally {
    clearTimeout(timer);
  }
};
