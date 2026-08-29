// Pixel Pro — Exa live web search proxy (primary fast path)
//
// Exa's "instant" search type is, in Exa's own words, "the lowest latency
// search optimized for real-time applications". That is exactly the trade the
// spoken path needs: a live answer that arrives while the person is still
// listening is worth more than a more thorough one that arrives after they
// have stopped caring.
//
// This function deliberately returns the SAME SHAPE the Tavily proxy returns
// -- { answer, results: [{ title, url, content, raw_content, score,
// published_date }] }. Everything downstream (mergeSearches, buildLiveContext,
// rankedSources, the passage extractor) was built against that shape, is
// working, and is not worth touching to swap a provider. The translation
// happens here, once, where it is visible.
//
// Verified against Exa's published OpenAPI specification before this was
// written: POST https://api.exa.ai/search, `x-api-key` header, request fields
// query / type / numResults / contents / category / startPublishedDate /
// userLocation, and result fields title / url / publishedDate / author /
// score / id / text. No parameter here is invented.
const EXA_URL = "https://api.exa.ai/search";

// Exa's own category vocabulary. Our callers speak Tavily's ("news",
// "finance", "general"), so map the one that has a real equivalent and leave
// the rest unset -- a wrong category is a filter that silently removes the
// answer, which is worse than no category at all.
function exaCategory(topic) {
  if (topic === "news") return "news";
  return null;                     // "finance" has no faithful Exa equivalent
}

// Tavily's time_range, expressed the way Exa expresses freshness: a floor on
// the published date. Exa has no time_range parameter.
function publishedAfter(timeRange) {
  const days = { day: 1, week: 7, month: 31, year: 366 }[timeRange];
  if (!days) return null;
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
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

  const KEY = process.env.EXA_API_KEY || process.env.EXA_KEY;
  if (!KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Exa API key is missing. Add EXA_API_KEY in Netlify environment variables.", stage: "config" }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad JSON.", stage: "request" }) }; }

  const query = String(payload.query || "").trim().slice(0, 1000);
  if (!query) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No search query.", stage: "request" }) };

  const topic = ["general", "news", "finance"].includes(payload.topic) ? payload.topic : "general";
  const freshness = ["day", "week", "month", "year"].includes(payload.timeRange) ? payload.timeRange : null;
  const maxResults = Math.min(10, Math.max(3, Number(payload.maxResults) || 6));

  // How much of each page to bring back. The grounding layer scores passages
  // against the question and throws the rest away, so asking for more text
  // than it will keep costs latency and buys nothing: a simple current-facts
  // question needs a few hundred characters from each of a few pages, not a
  // whole crawl. `deep` raises it for the research path that genuinely reads.
  const maxChars = payload.deep ? 4000 : 1200;

  const body = {
    query,
    // "instant" is the point of this file. A caller that genuinely needs
    // thorough retrieval asks for it explicitly.
    type: payload.deep ? "auto" : "instant",
    numResults: maxResults,
    contents: {
      // Text only. No highlights, no summary, no subpages: each of those is
      // additional server-side work on Exa's side before the response can be
      // sent, and the passage extractor downstream already does the job
      // highlights would do -- against the actual question, locally, for free.
      text: { maxCharacters: maxChars },
    },
  };

  const cat = exaCategory(topic);
  if (cat) body.category = cat;
  const after = publishedAfter(freshness);
  if (after) body.startPublishedDate = after;
  if (payload.country && String(payload.country).toLowerCase() === "india") body.userLocation = "IN";
  if (Array.isArray(payload.includeDomains) && payload.includeDomains.length) body.includeDomains = payload.includeDomains.slice(0, 50).map(String);
  if (Array.isArray(payload.excludeDomains) && payload.excludeDomains.length) body.excludeDomains = payload.excludeDomains.slice(0, 50).map(String);

  const timeoutMs = Math.min(30000, Math.max(3000, Number(payload.timeout) || 12000));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(EXA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "Accept": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    let d = null;
    try { d = await r.json(); } catch (_) { d = null; }

    if (!r.ok) {
      const msg = (d && (d.error || d.message)) || ("Exa search failed (" + r.status + ")");
      return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: String(msg), stage: "exa" }) };
    }

    const results = Array.isArray(d && d.results) ? d.results : [];
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        // Exa's /search returns no synthesised answer the way Tavily's does.
        // The grounding layer treats a missing one as simply having no
        // summary to lead with, which it already handles.
        answer: "",
        results: results.map((it) => ({
          title: it.title || "",
          url: it.url || "",
          // One text field upstream, two downstream. It goes in `content`:
          // buildLiveContext looks in raw_content first and falls back to
          // content, so leaving raw_content unset is what keeps an instant
          // search's evidence deliberately small.
          content: typeof it.text === "string" ? it.text : "",
          score: typeof it.score === "number" ? it.score : null,
          published_date: it.publishedDate || "",
          favicon: it.favicon || "",
        })),
        provider: "exa",
        searchType: (d && d.searchType) || body.type,
      }),
    };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: aborted ? "Exa search timed out." : "Exa search error.", stage: "exa" }),
    };
  } finally {
    clearTimeout(timer);
  }
};
