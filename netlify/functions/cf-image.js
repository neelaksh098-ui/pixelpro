// Pixel Pro — Cloudflare Workers AI image generation (primary image provider).
//
// Verified against Cloudflare's published Workers AI REST interface before
// this was written:
//
//   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}
//   Authorization: Bearer {api_token}
//   { "prompt": "<1..2048 chars>", "seed": <positive int>, "steps": <1..8> }
//   -> { "success": true, "result": { "image": "<base64 JPEG>" } }
//
// Two response shapes exist across Workers AI image models and the difference
// matters: the FLUX models return the JSON above with base64 in
// `result.image`, while the Stable Diffusion ones stream raw PNG bytes with
// no JSON envelope at all. Both are handled below, chosen by what the
// response actually says its content type is rather than by assuming from the
// model name -- a model that changes its output format should not silently
// produce a broken image.
//
// No parameter here is invented. `steps` is clamped to the documented 1..8.
const CF_BASE = "https://api.cloudflare.com/client/v4/accounts/";
const DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Use POST." }) };

  const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
  const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  if (!ACCOUNT || !TOKEN) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({
        error: "Cloudflare image generation is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Netlify environment variables.",
        stage: "config",
      }),
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad JSON.", stage: "request" }) }; }

  const prompt = String(payload.prompt || "").trim().slice(0, 2048);
  if (!prompt) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No prompt.", stage: "request" }) };

  const model = process.env.CLOUDFLARE_IMAGE_MODEL || DEFAULT_MODEL;

  const body = { prompt };
  // Documented range is 1..8 with a default of 4. Schnell is distilled for
  // few-step sampling: past about 6 the extra steps cost latency without
  // buying detail, which is the whole reason this model is the fast one.
  const steps = Number(payload.steps);
  body.steps = Number.isFinite(steps) ? Math.min(8, Math.max(1, Math.round(steps))) : 4;
  // A seed is sent so a repeated prompt is not a repeated picture. Omitting
  // it lets the service pick, but then "generate it again" can come back
  // identical, which reads as a failure.
  const seed = Number(payload.seed);
  body.seed = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : Math.floor(Math.random() * 2147483646) + 1;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);

  try {
    const r = await fetch(CF_BASE + encodeURIComponent(ACCOUNT) + "/ai/run/" + model, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const ctype = String(r.headers.get("content-type") || "").toLowerCase();

    // Raw-image models (the Stable Diffusion family) answer with the bytes.
    if (r.ok && ctype.indexOf("image/") === 0) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) {
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Cloudflare returned an empty image.", stage: "cloudflare" }) };
      }
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ dataUrl: "data:" + ctype.split(";")[0] + ";base64," + buf.toString("base64"), provider: "cloudflare", model }),
      };
    }

    let d = null;
    try { d = await r.json(); } catch (_) { d = null; }

    if (!r.ok || !d || d.success === false) {
      // Cloudflare reports problems as an `errors` array; its first entry is
      // the one worth showing, and it is the difference between "your token
      // lacks Workers AI" and "that prompt was rejected".
      const first = d && Array.isArray(d.errors) && d.errors.length ? d.errors[0] : null;
      const msg = (first && (first.message || first.code)) || (d && d.error) || ("Cloudflare image request failed (" + r.status + ")");
      return { statusCode: r.status === 200 ? 502 : r.status, headers: CORS, body: JSON.stringify({ error: String(msg), stage: "cloudflare" }) };
    }

    const img = d.result && d.result.image;
    if (typeof img !== "string" || !img) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Cloudflare returned no image data.", stage: "cloudflare" }) };
    }

    // FLUX returns base64 JPEG. Sent as a data URL because that is exactly
    // what the client already renders and download-links from, with no
    // intermediate object store to configure or pay for.
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ dataUrl: "data:image/jpeg;base64," + img, provider: "cloudflare", model }),
    };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    return {
      statusCode: 502, headers: CORS,
      body: JSON.stringify({ error: aborted ? "Cloudflare image generation timed out." : "Cloudflare image generation error.", stage: "cloudflare" }),
    };
  } finally {
    clearTimeout(timer);
  }
};
