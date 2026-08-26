const CACHE_VERSION = "pixelpro-v24";
const SHELL = ["/", "/index.html", "/privacy.html", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
const NEVER_CACHE = ["/.netlify/functions/", "api.groq.com", "api.tavily.com", "identitytoolkit.googleapis", "securetoken.googleapis", "firebaseapp.com/__/auth"];
function isNeverCache(url){ return NEVER_CACHE.some(function(f){ return url.indexOf(f) !== -1; }); }
self.addEventListener("install", function(event){
  event.waitUntil(caches.open(CACHE_VERSION).then(function(cache){
    return Promise.all(SHELL.map(function(url){ return cache.add(url).catch(function(){}); }));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(event){
  event.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.map(function(k){ if(k !== CACHE_VERSION) return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(event){
  var req = event.request;
  if(req.method !== "GET") return;
  var url = req.url;
  if(isNeverCache(url)) return;
  if(new URL(url).origin !== self.location.origin) return;
  if(req.mode === "navigate"){
    event.respondWith(fetch(req).then(function(res){
      var copy = res.clone();
      caches.open(CACHE_VERSION).then(function(c){ c.put("/index.html", copy); });
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
