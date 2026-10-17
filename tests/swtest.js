// The app's service worker, run for real against stand-ins for the browser's
// worker globals (self, caches, fetch). Two workers share this origin -- the
// app's at "/" and the launch site's at "/welcome/" -- and share its Cache
// Storage, so what matters is that the app's worker never touches what is
// not its own.
//
//   node tests/swtest.js [path/to/sw.js]
const fs = require("fs"), vm = require("vm"), path = require("path");
const file = process.argv[2] || path.join(__dirname, "..", "sw.js");
const src = fs.readFileSync(file, "utf8");

const P = [], F = [];
const chk = (n, ok, x) => (ok ? P : F).push(n + (ok ? "" : "  ::  " + JSON.stringify(x)));

function world(existing) {
  const stores = new Map((existing || []).map((k) => [k, new Map()]));
  const listeners = {};
  const caches = {
    open: async (k) => {
      if (!stores.has(k)) stores.set(k, new Map());
      const m = stores.get(k);
      return { add: async (u) => m.set(String(u), "shell"), put: async (r, v) => m.set(typeof r === "string" ? r : r.url, v) };
    },
    keys: async () => [...stores.keys()],
    delete: async (k) => stores.delete(k),
    match: async () => undefined,
  };
  const self = {
    location: { origin: "https://pixelpro7.netlify.app" },
    addEventListener: (t, fn) => (listeners[t] = fn),
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  const fetch = async () => ({ ok: true, status: 200, clone() { return this; } });
  const ctx = { self, caches, fetch, URL, Response: function (b, o) { this.body = b; this.o = o; }, Promise, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { listeners, stores };
}

async function fire(w, url, mode) {
  let responded = null;
  const ev = { request: { method: "GET", url: "https://pixelpro7.netlify.app" + url, mode: mode || "no-cors" },
               respondWith: (p) => (responded = p) };
  w.listeners.fetch(ev);
  if (responded) await responded;
  await new Promise((r) => setTimeout(r, 5));
  return !!responded;
}

(async () => {
  // ---- it stays out of the launch site's way ----
  let w = world();
  chk("does not handle the launch site's page", !(await fire(w, "/welcome/", "navigate")));
  chk("does not handle the launch site's stylesheet", !(await fire(w, "/welcome/css/site.css")));
  chk("does not handle the launch site's photos", !(await fire(w, "/welcome/media/rocket.jpg")));

  // ---- only APP pages become the offline copy of the app ----
  for (const [u, want] of [["/", true], ["/c/abc123", true], ["/index.html", true], ["/privacy.html", false]]) {
    w = world();
    await fire(w, u, "navigate");
    const saved = [...w.stores.values()].some((m) => m.has("/index.html"));
    chk((want ? "saves " : "does not save ") + u + " as the app's offline page", saved === want, { u, saved });
  }

  // ---- on update it clears only its own old caches ----
  w = world(["pixelpro-v40", "pixelpro-v61", "pixelpro-site-v2", "some-other-cache"]);
  let waited = null;
  w.listeners.activate({ waitUntil: (p) => (waited = p) });
  await waited;
  const left = [...w.stores.keys()].sort();
  chk("deletes its own old caches", !left.includes("pixelpro-v40") && !left.includes("pixelpro-v61"), left);
  chk("keeps the launch site's cache", left.includes("pixelpro-site-v2"), left);
  chk("keeps caches that belong to anything else", left.includes("some-other-cache"), left);

  console.log(JSON.stringify({ file: path.relative(process.cwd(), file), pass: P.length, fail: F.length }));
  F.forEach((f) => console.log("FAIL:", f));
  P.forEach((p) => console.log("pass:", p));
  process.exit(F.length ? 1 : 0);
})();
