// Pixel Pro — Workers AI model catalogue, read from YOUR account.
//
// Why this exists: Cloudflare's model list and the input schemas that go with
// it change faster than any document describing them, and getting a schema
// wrong is not a small error -- sending one property a model does not accept
// is rejected outright (that is exactly how image generation shipped broken:
// an unexpected `seed`, HTTP 400, every request). So rather than copy field
// names out of a blog post, this asks the account what it actually has.
//
// Read-only. It lists models and their schemas; it runs nothing and generates
// nothing. The API token never leaves the server, and no response from here
// contains it.
//
//   /.netlify/functions/cf-models                  -> every model, grouped by task
//   /.netlify/functions/cf-models?task=video       -> only tasks matching "video"
//   /.netlify/functions/cf-models?name=ltx         -> only models matching "ltx"
//   /.netlify/functions/cf-models?schema=@cf/...   -> the full schema for one model
const CF_BASE = "https://api.cloudflare.com/client/v4/accounts/";

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
  const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  if (!ACCOUNT || !TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({
      error: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Netlify environment variables.",
      stage: "config" }) };
  }

  const q = (event.queryStringParameters || {});
  const wantTask = String(q.task || "").toLowerCase();
  const wantName = String(q.name || "").toLowerCase();
  const wantSchema = String(q.schema || "");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  try {
    // Paged, because the catalogue is well past one page and a truncated list
    // looks exactly like "that model does not exist".
    let all = [];
    for (let page = 1; page <= 10; page++) {
      const url = CF_BASE + encodeURIComponent(ACCOUNT) + "/ai/models/search?per_page=100&page=" + page;
      const r = await fetch(url, {
        headers: { "Authorization": "Bearer " + TOKEN, "Accept": "application/json" },
        signal: ctrl.signal,
      });
      let d = null;
      try { d = await r.json(); } catch (_) { d = null; }
      if (!r.ok || !d || d.success === false) {
        const first = d && Array.isArray(d.errors) && d.errors.length ? d.errors[0] : null;
        return { statusCode: r.status === 200 ? 502 : r.status, headers: CORS, body: JSON.stringify({
          error: (first && (first.message || first.code)) || ("Model list failed (" + r.status + ")"),
          stage: "cloudflare" }) };
      }
      const rows = Array.isArray(d.result) ? d.result : [];
      all = all.concat(rows);
      if (rows.length < 100) break;
    }

    const taskOf = (m) => String((m.task && (m.task.name || m.task)) || "").toLowerCase();

    if (wantSchema) {
      const hit = all.find((m) => String(m.name || "") === wantSchema);
      if (!hit) return { statusCode: 404, headers: CORS, body: JSON.stringify({
        error: "No model named " + wantSchema + " on this account.", stage: "request" }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(hit, null, 2) };
    }

    let rows = all;
    if (wantTask) rows = rows.filter((m) => taskOf(m).indexOf(wantTask) >= 0);
    if (wantName) rows = rows.filter((m) => String(m.name || "").toLowerCase().indexOf(wantName) >= 0);

    // Grouped by task, because what matters first is "is there a video task at
    // all", and a flat list of 70 model ids does not answer that.
    const byTask = {};
    rows.forEach((m) => {
      const t = taskOf(m) || "(no task)";
      (byTask[t] = byTask[t] || []).push({
        name: m.name,
        description: String(m.description || "").slice(0, 160),
        // The two things that decide how this gets called at all.
        inputs: m.schema && m.schema.input && m.schema.input.properties
          ? Object.keys(m.schema.input.properties) : null,
        strict: m.schema && m.schema.input ? m.schema.input.additionalProperties === false : null,
      });
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      account_models_total: all.length,
      shown: rows.length,
      tasks: Object.keys(byTask).sort(),
      byTask,
    }, null, 2) };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    return { statusCode: 502, headers: CORS, body: JSON.stringify({
      error: aborted ? "Model list timed out." : "Model list error.", stage: "cloudflare" }) };
  } finally {
    clearTimeout(timer);
  }
};
