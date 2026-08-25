// Pixel Pro — Tavily live web search proxy
// All non-normal factual/user questions use Tavily first. API key stays server-side.
const TAVILY_URL = "https://api.tavily.com/search";

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Use POST." }) };

  const KEY = process.env.TAVILY_API_KEY || process.env.TAVILY_KEY || process.env.TAVILYAI_API_KEY;
  if (!KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Tavily API key is missing. Add TAVILY_API_KEY in Netlify environment variables.", stage: "config" }) };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad JSON.", stage: "request" }) }; }

  const query = String(payload.query || "").trim().slice(0, 1000);
  if (!query) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No search query.", stage: "request" }) };

  const topic = ["general", "news", "finance"].includes(payload.topic) ? payload.topic : "general";
  const freshness = ["day", "week", "month", "year"].includes(payload.timeRange) ? payload.timeRange : null;
  const maxResults = Math.min(10, Math.max(5, Number(payload.maxResults) || 8));
  const advanced = payload.searchDepth === "advanced";

  const base = {
    query,
    topic,
    search_depth: advanced ? "advanced" : "basic",
    max_results: maxResults,
    chunks_per_source: advanced ? 3 : 1,
    include_answer: advanced ? "advanced" : "basic",
    include_raw_content: advanced && payload.rawContent !== false ? "markdown" : false,
    include_images: false,
    include_favicon: true,
  };
  if (freshness) base.time_range = freshness;
  if (payload.country) base.country = String(payload.country).toLowerCase();
  if (Array.isArray(payload.includeDomains) && payload.includeDomains.length) base.include_domains = payload.includeDomains.slice(0, 50).map(String);
  if (Array.isArray(payload.excludeDomains) && payload.excludeDomains.length) base.exclude_domains = payload.excludeDomains.slice(0, 50).map(String);

  async function doSearch(body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(TAVILY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY, "Accept": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
  }

  try {
    // Advanced/current queries get adaptive retrieval; stable knowledge searches stay faster.
    let r;
    try {
      r = await doSearch(advanced ? { ...base, auto_parameters: true } : base, advanced ? 25000 : 14000);
    } catch (e) {
      if (e && e.name !== "AbortError") throw e;
      r = null;
    }

    if (!r || !r.ok) {
      r = await doSearch(base, advanced ? 25000 : 14000);
    }

    let d = null;
    try { d = await r.json(); } catch (_) {}
    if (!r.ok) {
      const msg = (d && d.detail && (d.detail.error || d.detail)) || (d && d.error) || "Tavily request failed.";
      return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: String(msg), stage: "tavily_response", status: r.status }) };
    }

    const results = Array.isArray(d && d.results) ? d.results.map((it) => ({
      title: it.title || it.url || "Web result",
      url: it.url || "",
      content: String(it.content || "").slice(0, 6000),
      raw_content: String(it.raw_content || "").slice(0, 14000),
      published_date: it.published_date || "",
      score: typeof it.score === "number" ? it.score : null,
      favicon: it.favicon || "",
    })).filter((it) => it.url) : [];

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        query: d && d.query ? d.query : query,
        answer: d && typeof d.answer === "string" ? d.answer : "",
        results,
        responseTime: d && d.response_time ? d.response_time : null,
        usage: d && d.usage ? d.usage : null,
        autoParameters: d && d.auto_parameters ? d.auto_parameters : null,
        requestId: d && d.request_id ? d.request_id : null,
      }),
    };
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: timedOut ? "Tavily search timed out." : "Tavily network error.", stage: "network" }) };
  }
};
