// Pixel Pro — Groq backend
// Fast everyday answers and image understanding. API key stays server-side.
const MODEL = "openai/gpt-oss-120b";
// A smaller sibling model on its own separate daily quota — used only as an
// automatic fallback the moment the primary model reports it is rate
// limited, so a busy day never surfaces as a dead end to the user.
const FALLBACK_MODEL = "openai/gpt-oss-20b";
// Llama 4 Maverick — Groq's flagship natively-multimodal model, used for
// image understanding. Swap here if Groq's model catalog changes.
const VISION_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const VISION_SYSTEM = "You are Pixel Pro's vision assistant. Look at the image closely before answering — read every piece of visible text exactly as written, identify objects, people, scenes, diagrams, charts, code, or documents precisely, and reason about spatial relationships, colors, counts, and fine details rather than guessing. Answer the user's exact question first, directly and precisely. If they didn't ask anything specific, give a clear, well-organized description of what's in the image, covering what matters most first. If something in the image is ambiguous or partly out of frame, say so plainly instead of guessing. Never say you cannot see or process images — you can. Keep the answer well-structured (short paragraphs or bullets where useful) and skip filler.";

function isRateLimited(status, data) {
  if (status === 429) return true;
  const msg = ((data && data.error && data.error.message) || "").toLowerCase();
  const type = ((data && data.error && data.error.type) || "").toLowerCase();
  return type.indexOf("rate_limit") !== -1 || msg.indexOf("rate limit") !== -1;
}
async function callGroqChat(KEY, model, messages, temperature, maxTokens, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: ctrl.signal,
    });
    const d = await r.json();
    return { ok: r.ok, status: r.status, data: d };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Use POST." }) };

  const KEY = process.env.GROQ_KEY;
  if (!KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Server key missing. Set GROQ_KEY in Netlify environment variables." }) };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad JSON." }) }; }

  if (payload.mode === "route") {
    const query = String(payload.query || "").trim().slice(0, 1200);
    if (!query) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No query." }) };
    const today = new Date().toISOString().slice(0, 10);
    const routeSystem = `You are Pixel Pro's web-search router. Today is ${today}. Decide whether the user's message needs a LIVE WEB SEARCH before the assistant answers. Accuracy matters more than speed: a wrong "no" produces a confidently outdated answer, which is the worst outcome.

Return ONLY one compact JSON object:
{"web":true|false,"confidence":0.0-1.0,"reason":"brief","search_query":"optimized query","topic":"general|news|finance","freshness":"none|day|week|month|year"}

ANSWER web=true when the correct answer depends on the state of the world right now, or on any fact that can change:
- current office-holders, leaders, CEOs, captains, champions, title-holders
- news, politics, elections, laws, policies, court rulings, wars, protests
- sport: scores, results, fixtures, standings, transfers, records
- weather, air quality, disasters
- prices: products, stocks, crypto, currency, fuel, gold, tickets
- products: latest models, specs, availability, release dates, comparisons of current products
- software/library/model versions, changelogs, deprecations
- schedules, timings, opening hours, flights, trains, exams, results
- rankings, "best X" / "top X" recommendations where the market moves
- any named real-world company, person, product or place whose present status matters
- anything containing today/now/current/latest/recent/this week/this year/2025/2026
- when you are not confident the answer is stable, choose true

ANSWER web=false ONLY for genuinely timeless work:
- arithmetic, algebra, calculus, unit conversion
- writing, rewriting, summarising or translating text the user supplied
- code the user pasted; explaining a language feature or algorithm
- established science, history before this year, grammar, definitions
- creative writing, jokes, brainstorming
- recipes, general how-to that does not depend on current products
- pure chit-chat, greetings, thanks, small talk
- questions about the assistant itself

TIE-BREAK: if a question could go either way, choose web=true. A needless search costs a second; a stale answer costs trust.

SEARCH QUERY: when web=true, write search_query as a precise standalone query a search engine would answer well. Keep names, places, products, teams, metrics and dates. For changing facts, phrase it for the current state and add the year when useful. Never copy filler words like "tell me" or "can you".

FRESHNESS: day for today/breaking/live/scores/weather; week for this week; month for recent trends and new releases; year for this-year facts; none otherwise.
TOPIC: news for news/politics/sport/elections; finance for markets/prices/stocks/crypto; general otherwise.

EXAMPLES:
"who is the cm of west bengal" -> {"web":true,...,"topic":"news","freshness":"month"}
"iphone 17 price in india" -> {"web":true,...,"topic":"general","freshness":"week"}
"integrate x^2 dx" -> {"web":false,...,"freshness":"none"}
"best laptop under 60000" -> {"web":true,...,"freshness":"month"}
"rewrite this email politely: ..." -> {"web":false,...}
"who won yesterday's match" -> {"web":true,...,"topic":"news","freshness":"day"}
"what is photosynthesis" -> {"web":false,...}
"hi how are you" -> {"web":false,...}

Do NOT answer the question. Classify only.`;
    const routeMessages = [
      { role: "system", content: routeSystem },
      { role: "user", content: query }
    ];
    try {
      let res = await callGroqChat(KEY, MODEL, routeMessages, 0, 120, 7000);
      if (!res.ok && isRateLimited(res.status, res.data)) {
        res = await callGroqChat(KEY, FALLBACK_MODEL, routeMessages, 0, 120, 7000);
      }
      if (!res.ok) {
        const msg = (res.data && res.data.error && res.data.error.message) || "Groq routing request failed.";
        return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: msg, stage: "groq_route" }) };
      }
      const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content;
      if (!text) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Empty routing reply from Groq." }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ route: String(text).trim() }) };
    } catch (e) {
      const timedOut = e && e.name === "AbortError";
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: timedOut ? "Groq router timed out." : "Groq router error.", stage: "groq_route" }) };
    }
  }

  let messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  if (!messages.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No messages." }) };

  const liveContext = String(payload.liveContext || "").trim();
  if (liveContext && !payload.vision) {
    messages.unshift({
      role: "system",
      content: "LIVE WEB CONTEXT — retrieved moments ago from Tavily. Answer the user's exact question using the retrieved information. Prefer the Tavily answer and the most relevant source excerpts. Do NOT refuse merely because one source is incomplete or because the sources do not use the exact wording of the question. Synthesize the best supported answer from the available evidence. Mention uncertainty only when the evidence truly conflicts or is insufficient. Keep the answer concise and do not invent facts.\n\n" + liveContext.slice(0, 10000),
    });
  }

  if (payload.vision) {
    // Keep only the latest user turn (image + question) so the vision
    // model isn't distracted by unrelated prior text history, but give
    // it a real, precision-focused system prompt instead of none at all.
    let lastUserMsg = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserMsg = messages[i]; break; }
    }
    messages = lastUserMsg ? [{ role: "system", content: VISION_SYSTEM }, lastUserMsg] : [{ role: "system", content: VISION_SYSTEM }];
  }

  try {
    // Pixel Lite explicitly asks for the smaller/faster model -- genuinely
    // quicker, not just a relabeled version of the same model.
    const model = payload.vision ? VISION_MODEL : (payload.lite ? FALLBACK_MODEL : MODEL);
    const temperature = payload.vision ? 0.2 : 0.35;
    const maxTokens = payload.vision ? 1400 : 900; // back to the original budget — 4000 was draining the daily token quota far too fast
    const timeoutMs = payload.vision ? 20000 : 17000;

    let res = await callGroqChat(KEY, model, messages, temperature, maxTokens, timeoutMs);
    // If the primary model alone is out of daily tokens, silently retry on
    // the fallback model's own separate quota instead of showing an error —
    // this is what actually keeps the app answering on a busy day.
    if (!res.ok && !payload.vision && model !== FALLBACK_MODEL && isRateLimited(res.status, res.data)) {
      res = await callGroqChat(KEY, FALLBACK_MODEL, messages, temperature, maxTokens, timeoutMs);
    } else if (!res.ok && !payload.vision && model === FALLBACK_MODEL && isRateLimited(res.status, res.data)) {
      // Pixel Lite's own model is rate limited too -- fall back up to the main model rather than retrying the same one.
      res = await callGroqChat(KEY, MODEL, messages, temperature, maxTokens, timeoutMs);
    }

    if (!res.ok) {
      const msg = (res.data && res.data.error && res.data.error.message) || "Groq request failed.";
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: msg, stage: "groq_response" }) };
    }

    const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content;
    if (!text) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Empty reply from Groq." }) };

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: String(text).trim() }) };
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: timedOut ? "Groq took too long to respond." : "Upstream Groq error.", stage: "network" }),
    };
  }
};
