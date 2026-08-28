// Pixel Pro — streaming chat endpoint (Netlify Functions v2).
// Streams Groq's tokens straight through to the browser so words appear as
// they are generated instead of arriving in one lump at the end.
// The classic buffered endpoint (/groq) stays as an automatic fallback.

const MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

export default async (req) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Use POST.", { status: 405, headers: CORS });

  const KEY = process.env.GROQ_KEY;
  if (!KEY) {
    return new Response(JSON.stringify({ error: "Server key missing. Set GROQ_KEY." }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let payload;
  try { payload = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Bad JSON." }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }); }

  // Warm-up ping — see warmFunctions() in index.html. Returns instantly and
  // spends no Groq tokens; its only job is to leave this container running.
  if (payload.warm === true) {
    return new Response(JSON.stringify({ warm: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  if (!messages.length) {
    return new Response(JSON.stringify({ error: "No messages." }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // A deep-research report is synthesised from dozens of sources at once, so
  // it needs a far bigger evidence window and far more room to write than an
  // ordinary grounded answer.
  const isReport = payload.report === true;

  const liveContext = String(payload.liveContext || "").trim();
  if (liveContext) {
    messages.unshift({
      role: "system",
      content:
        "LIVE WEB CONTEXT — retrieved moments ago. Ground your answer in this evidence. Prefer the most recent and most relevant sources, state figures and dates exactly as reported, and say plainly when the sources disagree or do not cover something. Never invent details that are not supported here.\n\n" +
        liveContext.slice(0, isReport ? 90000 : 14000),
    });
  }

  const model = payload.lite ? FALLBACK_MODEL : MODEL;
  const maxTokens = isReport ? 8000 : (payload.deep ? 2600 : 1500);
  const temperature = isReport ? 0.25 : (payload.deep ? 0.3 : 0.35);

  // Groq's service tier, documented values: auto | on_demand | flex |
  // performance | null. Omitting it means on_demand, which is the standard
  // tier and takes queue latency at peak times.
  //
  // "auto" is the only one that is right to hardcode. "performance" is
  // enterprise-only and "flex" is explicitly best-effort -- it raises rate
  // limits but can answer with an over-capacity error, which trades
  // reliability for throughput and is the wrong trade for a spoken reply that
  // has to arrive. "auto" asks for the best tier this account actually has,
  // whatever that is, and can never be worse than the default it replaces.
  const SERVICE_TIER = "auto";

  async function openStream(useModel, withTier) {
    const body = { model: useModel, messages, temperature, max_tokens: maxTokens, stream: true };
    if (withTier) body.service_tier = SERVICE_TIER;
    return fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify(body),
    });
  }

  let upstream;
  try {
    upstream = await openStream(model, true);
    // An account or API version that does not know the parameter must not
    // lose its answer over it: drop the tier and ask again, once.
    if (upstream.status === 400) {
      upstream = await openStream(model, false);
    }
    if (!upstream.ok && (upstream.status === 429 || upstream.status >= 500) && model !== FALLBACK_MODEL) {
      upstream = await openStream(FALLBACK_MODEL, true);
    }
  } catch {
    return new Response(JSON.stringify({ error: "Upstream Groq error." }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  if (!upstream.ok || !upstream.body) {
    let msg = "Groq request failed.";
    try { const d = await upstream.json(); msg = (d && d.error && d.error.message) || msg; } catch {}
    return new Response(JSON.stringify({ error: msg }), { status: upstream.status || 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Re-emit Groq's SSE as a plain text stream of content deltas.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const data = t.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              const piece = j.choices?.[0]?.delta?.content;
              if (piece) controller.enqueue(encoder.encode(piece));
            } catch { /* partial JSON chunk, ignore */ }
          }
        }
      } catch {
        // surface nothing extra; whatever streamed already stands
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
};
