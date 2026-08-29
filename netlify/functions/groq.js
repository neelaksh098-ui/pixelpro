// Pixel Pro — Groq backend
// Fast everyday answers and image understanding. API key stays server-side.
// Primary everywhere, for the same reason as the streaming endpoint: this is
// the model the fast path runs on. See chat-stream.mjs.
const MODEL = "openai/gpt-oss-20b";
// A smaller sibling model on its own separate daily quota — used only as an
// automatic fallback the moment the primary model reports it is rate
// limited, so a busy day never surfaces as a dead end to the user.
const ESCALATE_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = ESCALATE_MODEL;   /* kept for the call sites below */
// Llama 4 Maverick — Groq's flagship natively-multimodal model, used for
// image understanding. Swap here if Groq's model catalog changes.
const VISION_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
// Second vision-capable model, used when the first is rate limited, erroring
// or retired — without it a single hiccup made a photo un-analysable.
const VISION_FALLBACK_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const VISION_SYSTEM = "You are Pixel Pro's vision assistant. Look at the image closely before answering — read every piece of visible text exactly as written, identify objects, people, scenes, diagrams, charts, code, or documents precisely, and reason about spatial relationships, colors, counts, and fine details rather than guessing. Answer the user's exact question first, directly and precisely. If they didn't ask anything specific, give a clear, well-organized description of what's in the image, covering what matters most first. If something in the image is ambiguous or partly out of frame, say so plainly instead of guessing. Never say you cannot see or process images — you can. Keep the answer well-structured (short paragraphs or bullets where useful) and skip filler. Your developer and creator is Mr. Neelaksh Naithani; if asked who made you, always say so and never name anyone else.";

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

  // A warm-up ping: the point is only to have this container already running
  // when the real request arrives, so it must return immediately and must not
  // spend a Groq call doing it.
  if (payload.warm === true) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ warm: true }) };
  }

  if (payload.mode === "route") {
    const query = String(payload.query || "").trim().slice(0, 1200);
    if (!query) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No query." }) };
    const today = new Date().toISOString().slice(0, 10);
    const routeSystem = `You are Pixel Pro's web-search router. Today is ${today}. Decide whether the user's message needs a LIVE WEB SEARCH before the assistant answers.

You only ever see the hard cases. Obvious ones — arithmetic, greetings, today's news — are settled before they reach you. So assume the question is genuinely balanced and think about which way it actually leans.

Return ONLY one compact JSON object, no prose, no code fence:
{"web":true|false,"confidence":0.0-1.0,"reason":"brief","search_query":"optimized query","topic":"general|news|finance","freshness":"none|day|week|month|year"}

THE TEST, in one line: would a well-informed person who stopped reading the news a year ago still give the right answer? If no, web=true.

web=true when the answer depends on the state of the world right now:
- who currently holds a role: leaders, CEOs, captains, coaches, champions, title-holders
- news, politics, elections, laws just passed, court rulings, conflicts, disasters
- sport: scores, results, fixtures, standings, transfers, current records
- weather, air quality, anything happening outdoors today
- money: prices, stocks, crypto, currency, fuel, gold, fares, fees, tax rates
- products: current models, specs, availability, release dates, what to buy now
- software and model versions, changelogs, what is deprecated, what is supported
- schedules and statuses: flights, trains, exams, results, opening hours, deadlines
- "best X" or "top X" where the market moves
- statistics that drift: population, net worth, market share, box office, user counts
- whether something is still true: still banned, still free, still available, already released
- anything naming a real company, product, person or place whose present state matters

web=false when the answer is stable knowledge or is about the user's own text:
- maths of any kind, unit conversion, formulas, named constants
- rewriting, summarising, translating or correcting text the user supplied
- code the user pasted; explaining a language feature, algorithm or data structure
- settled science, established history, geography constants, grammar, definitions
- creative writing, jokes, brainstorming, naming things, plans and checklists
- recipes and practical how-to that does not depend on a current product
- personal advice, study help, hypotheticals and role-play
- questions about the assistant itself

THE CASES THAT TRIP ROUTERS UP — get these right:
- A live-sounding word inside a stable question does NOT make it live.
  "how does the stock market work" is a mechanism -> false.
  "why did the stock market fall today" is an event -> true.
- A stable-sounding verb wrapped around live data does NOT make it stable.
  "explain the new tax rules announced this year" -> true.
  "calculate how much 10g of gold costs today" -> true (it needs today's rate).
- "what does X mean" is a definition even when X is a market term -> false.
- "write a poem about the news" is a poem -> false.
- A past year with no recency word is history -> false. "who won in 1998" -> false.
- Comparing two named current products -> true. Comparing two concepts -> false.
- A person's biography is stable; their current role is not. If the question is
  "who is <person>" and their present position is the point, choose true.

TIE-BREAK: if it could genuinely go either way, choose web=true. A needless search costs a second; a confidently stale answer costs trust. Set confidence honestly — below 0.5 means you are unsure, and the app will search anyway.

SEARCH QUERY: when web=true, write search_query as a precise standalone query a search engine would answer well. Keep names, places, products, teams, metrics. Add the year for anything that changes annually. Drop filler like "tell me" or "can you". Translate Hindi/Hinglish into the English a search engine indexes.

FRESHNESS: day for today, breaking, live, scores, weather. week for this week, new releases. month for recent trends, current office-holders. year for this-year facts. none otherwise.
TOPIC: news for news, politics, sport, elections. finance for markets, prices, stocks, crypto. general otherwise.

EXAMPLES:
"who is the cm of west bengal" -> {"web":true,"confidence":0.95,"topic":"news","freshness":"month","search_query":"current chief minister of West Bengal ${today.slice(0,4)}"}
"how does weather forecasting work" -> {"web":false,"confidence":0.9,"freshness":"none"}
"explain why the market fell today" -> {"web":true,"confidence":0.95,"topic":"finance","freshness":"day"}
"what does gdp mean" -> {"web":false,"confidence":0.95}
"who won the world cup in 1998" -> {"web":false,"confidence":0.85}
"aaj ka gold rate" -> {"web":true,"confidence":0.95,"topic":"finance","freshness":"day","search_query":"gold rate today India per gram"}
"is python better than java" -> {"web":false,"confidence":0.6}
"how much gold can i carry to india" -> {"web":true,"confidence":0.7,"freshness":"year","search_query":"India customs gold allowance limit passenger ${today.slice(0,4)}"}
"tell me about the eiffel tower" -> {"web":false,"confidence":0.7}

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
    // 20b is the default here too. `heavy` -- evidence to synthesise -- is
    // the only thing that escalates, and live context implies it even if the
    // caller did not say so. `lite` used to select the small model and now
    // describes what already happens, so it is simply ignored.
    const heavy = payload.heavy === true || !!String(payload.liveContext || "").trim();
    const model = payload.vision ? VISION_MODEL : (heavy ? ESCALATE_MODEL : MODEL);
    const temperature = payload.vision ? 0.2 : 0.35;
    const maxTokens = payload.vision ? 1400 : 900; // back to the original budget — 4000 was draining the daily token quota far too fast
    // A photo is a megabyte or two of upload before inference even starts, so
    // 20s was cutting off perfectly good requests on a phone connection.
    const timeoutMs = payload.vision ? 26000 : 17000;

    let res = await callGroqChat(KEY, model, messages, temperature, maxTokens, timeoutMs);
    // If the primary model alone is out of daily tokens, silently retry on
    // the fallback model's own separate quota instead of showing an error —
    // this is what actually keeps the app answering on a busy day.
    if (!res.ok && payload.vision && (isRateLimited(res.status, res.data) || res.status >= 500 || res.status === 404)) {
      // Vision had no second chance at all: one rate limit, one hiccup, or one
      // decommissioned model and the photo simply failed. It gets the same
      // treatment as text now.
      res = await callGroqChat(KEY, VISION_FALLBACK_MODEL, messages, temperature, maxTokens, timeoutMs);
    } else if (!res.ok && !payload.vision && isRateLimited(res.status, res.data)) {
      // Out of quota on one size: the other has its own, and an answer from
      // the wrong size beats no answer.
      const other = model === MODEL ? ESCALATE_MODEL : MODEL;
      res = await callGroqChat(KEY, other, messages, temperature, maxTokens, timeoutMs);
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
