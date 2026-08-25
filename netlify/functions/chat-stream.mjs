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

  let messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  if (!messages.length) {
    return new Response(JSON.stringify({ error: "No messages." }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const liveContext = String(payload.liveContext || "").trim();
  if (liveContext) {
    messages.unshift({
      role: "system",
      content:
        "LIVE WEB CONTEXT — retrieved moments ago. Ground your answer in this evidence. Prefer the most recent and most relevant sources, state figures and dates exactly as reported, and say plainly when the sources disagree or do not cover something. Never invent details that are not supported here.\n\n" +
        liveContext.slice(0, 14000),
    });
  }

  const model = payload.lite ? FALLBACK_MODEL : MODEL;
  const maxTokens = payload.deep ? 2600 : 1500;
  const temperature = payload.deep ? 0.3 : 0.35;

  async function openStream(useModel) {
    return fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model: useModel, messages, temperature, max_tokens: maxTokens, stream: true }),
    });
  }

  let upstream;
  try {
    upstream = await openStream(model);
    if (!upstream.ok && (upstream.status === 429 || upstream.status >= 500) && model !== FALLBACK_MODEL) {
      upstream = await openStream(FALLBACK_MODEL);
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
