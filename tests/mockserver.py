"""Serves the app and stands in for every Netlify function it calls.

Run it from the repo root:  python3 tests/mockserver.py [port]

Nothing here is clever. Each endpoint returns the smallest well-formed
response the real service would, so a test exercises the app's handling of a
real response shape rather than its handling of a stub. Behaviour is tunable
per request via /__cfg so a test can change it without a restart.
"""
import http.server, socketserver, json, os, sys, time, base64, struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8880

ANSWER = ("The iPhone 17 Pro is Apple's latest iPhone. It was announced in September 2026 "
          "and ships with the A19 Pro chip. Pre-orders opened on the twelfth.")

CFG = {
    "ttft": 180.0,       # ms to first streamed token
    "cps": 900.0,        # streamed characters per second
    "text": ANSWER,
    "route_web": True,   # what the remote classifier says
    "route_ms": 90.0,
    "exa_ms": 300.0,
    "exa_status": 200,
    "exa_results": 2,
    "tavily_status": 200,
}

# 64x64 solid PNG, base64. Deliberately larger than it will be displayed.
FAVICON_64 = ("data:image/png;base64,"
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAPklEQVR42u3OMQEAAAgDoC251a3g"
  "IQQyQ3JVAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPBtAVoYAAHsLzkJAAAAAElFTkSuQmCC")

def exa_payload(n):
    rows = [
        {"title": "Apple unveils iPhone 17 Pro", "url": "https://www.apple.com/newsroom/iphone-17?src=hp",
         "text": "Apple today announced iPhone 17 Pro, its latest iPhone, available 19 September 2026 with the A19 Pro chip.",
         "score": 0.94, "publishedDate": "2026-08-20",
         # A real 64x64 image, inline, so the favicon under test actually
         # decodes without leaving the machine. A natural size well above the
         # 14px the row allows is the point: that is what went wrong.
         "favicon": FAVICON_64},
        {"title": "iPhone 17 Pro hands on", "url": "https://www.theverge.com/iphone-17-pro-review",
         "text": "The iPhone 17 Pro is the newest iPhone Apple sells, replacing last year's iPhone 16 Pro.",
         "score": 0.81, "publishedDate": "2026-08-25", "favicon": ""},
        {"title": "iPhone 17 Pro specifications", "url": "https://support.apple.com/iphone-17-pro",
         "text": "iPhone 17 Pro technical specifications, including the A19 Pro chip and camera system.",
         "score": 0.72, "publishedDate": "2026-08-21", "favicon": ""},
    ]
    return {"answer": "", "results": rows[:max(0, n)], "provider": "exa", "searchType": "instant"}

def tavily_payload():
    return {"answer": "The latest iPhone is the iPhone 17 Pro.",
            "results": [{"title": "Apple iPhone 17 Pro", "url": "https://www.apple.com/iphone-17-pro",
                         "content": "Apple's latest iPhone is the iPhone 17 Pro, announced September 2026.",
                         "score": 0.9, "published_date": "2026-08-20"}]}

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass

    def _json(self, obj, status=200):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/c/"): self.path = "/index.html"
        if self.path.startswith("/__cfg"):
            import urllib.parse as up
            q = up.parse_qs(up.urlparse(self.path).query)
            for k, v in q.items():
                if k not in CFG: continue
                cur = CFG[k]
                CFG[k] = (v[0] == "1" or v[0].lower() == "true") if isinstance(cur, bool) \
                    else (float(v[0]) if isinstance(cur, float) else
                          int(v[0]) if isinstance(cur, int) else v[0])
            return self._json(CFG)
        return super().do_GET()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode("utf-8", "ignore")
        try: body = json.loads(raw)
        except Exception: body = {}
        p = self.path

        if p.endswith("chat-stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            time.sleep(CFG["ttft"] / 1000.0)
            text, per = CFG["text"], 1.0 / CFG["cps"]
            for i in range(0, len(text), 6):
                try:
                    self.wfile.write(text[i:i+6].encode()); self.wfile.flush()
                except Exception: return
                time.sleep(per * 6)
            return

        if p.endswith("/groq"):
            if body.get("mode") == "route":
                time.sleep(CFG["route_ms"] / 1000.0)
                return self._json({"route": json.dumps(
                    {"web": bool(CFG["route_web"]), "confidence": 0.9, "reason": "test",
                     "search_query": body.get("query", ""), "topic": "general", "freshness": "day"})})
            if "You name chat" in raw: return self._json({"text": "Chat"})
            return self._json({"text": CFG["text"]})

        if p.endswith("/exa"):
            time.sleep(CFG["exa_ms"] / 1000.0)
            if CFG["exa_status"] != 200:
                return self._json({"error": "exa down", "stage": "exa"}, CFG["exa_status"])
            return self._json(exa_payload(CFG["exa_results"]))

        if p.endswith("/tavily"):
            if CFG["tavily_status"] != 200:
                return self._json({"error": "tavily down", "stage": "tavily"}, CFG["tavily_status"])
            return self._json(tavily_payload())

        if p.endswith("/tts-token"):
            # expiresAt is not optional: ttsTokenFresh() treats a token
            # without one as already dead, so the app would silently use the
            # HTTP fallback for every sentence and the socket path would
            # never be exercised at all.
            return self._json({"token": "test-token", "version": "2024-06-10",
                               "model": "sonic-2", "voiceId": "test-voice",
                               "expiresAt": int((time.time() + 900) * 1000),
                               "mime": "audio/wav", "speed": "normal",
                               "outputFormat": {"container": "raw", "encoding": "pcm_s16le",
                                                "sample_rate": 22050}})

        if p.endswith("/tts"):
            # a tiny valid WAV, so the HTTP fallback path can decode something
            rate, secs = 22050, 0.2
            frames = int(rate * secs)
            pcm = b"".join(struct.pack("<h", int(3000 * (1 if (i // 60) % 2 else -1))) for i in range(frames))
            hdr = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
                   struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) +
                   b"data" + struct.pack("<I", len(pcm)))
            wav = hdr + pcm
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers(); self.wfile.write(wav); return

        if p.endswith("/cf-image") or p.endswith("/stability-image"):
            png = base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+4m3mAAAAAElFTkSuQmCC")
            return self._json({"dataUrl": "data:image/png;base64," + base64.b64encode(png).decode(),
                               "provider": "mock"})

        return self._json({"error": "no mock for " + p}, 404)

if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as srv:
        print("mock server on http://127.0.0.1:%d (root %s)" % (PORT, ROOT), flush=True)
        srv.serve_forever()
