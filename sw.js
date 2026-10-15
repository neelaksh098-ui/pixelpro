/* Pixel Pro app service worker -- scope "/".

   The launch site at /welcome/ has a service worker of its own, scoped to
   /welcome/, with its own caching rules. Two workers share one origin and
   therefore one Cache Storage, so this one is written to keep out of the
   other's way:

   1. It never handles /welcome/ requests. On a first visit, before the
      launch site's worker is installed, those pages would otherwise be
      served -- and cached -- by this worker.
   2. Only APP navigations are saved as the offline copy of /index.html.
      This used to save EVERY navigation response under that key, so a
      single visit to the launch site would have made it the app's offline
      page.
   3. On activation it deletes only its OWN old caches ("pixelpro-v*"). It
      used to delete every cache that was not its current one, which would
      have emptied the launch site's cache every time the app updated. */
const CACHE_VERSION = "pixelpro-v63";
const CACHE_PREFIX = "pixelpro-v";
const SHELL = ["/", "/index.html", "/privacy.html", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
const NEVER_CACHE = ["/.netlify/functions/", "api.cartesia.ai", "api.groq.com", "api.tavily.com", "api.exa.ai", "identitytoolkit.googleapis", "securetoken.googleapis", "firebaseapp.com/__/auth"];
function isNeverCache(url){ return NEVER_CACHE.some(function(f){ return url.indexOf(f) !== -1; }); }
function isLaunchSite(path){ return path === "/welcome" || path.indexOf("/welcome/") === 0; }
function isAppNavigation(path){ return path === "/" || path === "/index.html" || path.indexOf("/c/") === 0; }

self.addEventListener("install", function(event){
  event.waitUntil(caches.open(CACHE_VERSION).then(function(cache){
    return Promise.all(SHELL.map(function(url){ return cache.add(url).catch(function(){}); }));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(event){
  event.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.map(function(k){
      if(k !== CACHE_VERSION && k.indexOf(CACHE_PREFIX) === 0) return caches.delete(k);
    }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(event){
  var req = event.request;
  if(req.method !== "GET") return;
  var url = req.url;
  if(isNeverCache(url)) return;
  var u = new URL(url);
  if(u.origin !== self.location.origin) return;
  if(isLaunchSite(u.pathname)) return;               /* the launch site's own worker handles it */
  if(req.mode === "navigate"){
    event.respondWith(fetch(req).then(function(res){
      if(res && res.ok && isAppNavigation(u.pathname)){
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function(c){ c.put("/index.html", copy); });
      }
      return res;
    }).catch(function(){
      return caches.match("/index.html").then(function(hit){
        return hit || new Response("<h1>Pixel Pro is offline</h1><p>Reconnect to continue.</p>", { headers: {"Content-Type":"text/html"} });
      });
    })); return;
  }
  event.respondWith(caches.match(req).then(function(hit){
    var network = fetch(req).then(function(res){
      if(res && res.status === 200){ var copy = res.clone(); caches.open(CACHE_VERSION).then(function(c){ c.put(req, copy); }); }
      return res;
    }).catch(function(){ return hit; });
    return hit || network;
  }));
});
