// Pixel Pro — emails a chat exchange to the signed-in user's own inbox.
//
// Two providers are supported so this works whether or not you own a domain:
//
//  1. BREVO_API_KEY  — Brevo lets you verify a single ordinary address (e.g. your
//     own Gmail) as the sender, so it can deliver to ANY signed-in user's inbox
//     with no domain purchase. Free tier: 300 emails/day.
//     Key: brevo.com → Settings → SMTP & API → API Keys.
//     Sender: Brevo → Senders → add + verify your address, then set BREVO_FROM.
//
//  2. RESEND_API_KEY — Resend's shared onboarding@resend.dev sender can only
//     deliver to the Resend account owner's own address. To reach anyone you must
//     verify a domain you own and set RESEND_FROM to an address on it.
//
// Brevo is used when both are set. If neither is configured (or a send fails)
// the browser falls back to opening a pre-filled Gmail compose tab.
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const RESEND_URL = "https://api.resend.com/emails";

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml(question, answer) {
  return (
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;color:#111">' +
    '<p style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;margin:0 0 18px">Pixel Pro</p>' +
    (question ? '<p style="background:#f5f5f6;border-radius:10px;padding:12px 14px;margin:0 0 16px;color:#333"><b>You asked:</b> ' + escHtml(question) + "</p>" : "") +
    '<div style="font-size:15px;line-height:1.65;white-space:pre-wrap">' + escHtml(answer) + "</div>" +
    '<p style="margin-top:28px;font-size:12px;color:#999">Sent automatically from Pixel Pro because you turned on "Also email me this" in the composer.</p>' +
    "</div>"
  );
}

// "Pixel Pro <a@b.com>" or "a@b.com" -> { name, email }
function parseFrom(raw, fallbackName) {
  const s = String(raw || "").trim();
  const m = s.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: (m[1] || fallbackName).replace(/^"|"$/g, "") || fallbackName, email: m[2] };
  return { name: fallbackName, email: s };
}

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    let d = {};
    try { d = await r.json(); } catch (_) {}
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

  const BREVO_KEY = process.env.BREVO_API_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!BREVO_KEY && !RESEND_KEY) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: "No email provider configured. Set BREVO_API_KEY (works with a verified Gmail sender, no domain needed) or RESEND_API_KEY in Netlify environment variables.",
        stage: "config",
      }),
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad JSON." }) }; }

  const to = String(payload.to || "").trim();
  const question = String(payload.question || "").trim().slice(0, 4000);
  const answer = String(payload.answer || "").trim().slice(0, 20000);
  const subject = String(payload.subject || "Pixel Pro").trim().slice(0, 200) || "Pixel Pro";

  if (!to || to.indexOf("@") < 0) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing or invalid recipient." }) };
  if (!answer) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Nothing to send." }) };

  const html = buildHtml(question, answer);

  try {
    if (BREVO_KEY) {
      const from = parseFrom(process.env.BREVO_FROM || process.env.SENDER_EMAIL, "Pixel Pro");
      if (!from.email || from.email.indexOf("@") < 0) {
        return {
          statusCode: 500,
          headers: CORS,
          body: JSON.stringify({ error: "Set BREVO_FROM to the sender address you verified in Brevo, e.g. \"Pixel Pro <you@gmail.com>\".", stage: "config" }),
        };
      }
      const res = await postJson(
        BREVO_URL,
        { "Content-Type": "application/json", accept: "application/json", "api-key": BREVO_KEY },
        { sender: { name: from.name, email: from.email }, to: [{ email: to }], subject, htmlContent: html },
        15000
      );
      if (!res.ok) {
        const msg = (res.data && (res.data.message || res.data.error)) || "Brevo request failed.";
        return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: msg, stage: "brevo" }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: res.data && res.data.messageId, provider: "brevo" }) };
    }

    const FROM = process.env.RESEND_FROM || "Pixel Pro <onboarding@resend.dev>";
    const res = await postJson(
      RESEND_URL,
      { "Content-Type": "application/json", Authorization: "Bearer " + RESEND_KEY },
      { from: FROM, to: [to], subject, html },
      15000
    );
    if (!res.ok) {
      const msg = (res.data && (res.data.message || res.data.error)) || "Resend request failed.";
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: msg, stage: "resend" }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: res.data && res.data.id, provider: "resend" }) };
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: timedOut ? "Email provider took too long to respond." : "Upstream email provider error.", stage: "network" }),
    };
  }
};
