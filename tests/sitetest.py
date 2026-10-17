"""The two halves of the site -- launch site and app -- as one journey.

A brand-new visitor, the "Try Pixel Pro" button, signing in, coming back,
signing out, an expired session. Every check is made on where the browser
actually ended up and what it actually drew.

    python3 tests/mockserver.py 8880 &
    python3 tests/sitetest.py
"""
import asyncio, json, os, sys, functools
print = functools.partial(print, flush=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shims import FAKE_FIREBASE, SIGNED_IN_FLAG
from playwright.async_api import async_playwright

CHROME = os.environ.get("PW_CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
BASE = os.environ.get("PP_BASE", "http://127.0.0.1:8880")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P, F = [], []
def chk(name, ok, extra=""):
    (P if ok else F).append(name + ("" if ok else "  ::  " + str(extra)))

def path(pg):
    u = pg.url.split(BASE, 1)[-1]
    return u

async def fresh(b, init="", user=None):
    ctx = await b.new_context(viewport={"width": 390, "height": 844})
    # The real Firebase SDK is a third party; the fake stands in for it.
    await ctx.route("**/firebasejs/**", lambda r: r.abort())
    pre = ("window.__fakeAuthUser=" + json.dumps(user) + ";") if user else ""
    await ctx.add_init_script(pre + FAKE_FIREBASE + init)
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    return ctx, pg, errs

async def settle(pg, ms=900):
    try: await pg.wait_for_load_state("domcontentloaded")
    except Exception: pass
    await pg.wait_for_timeout(ms)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])

        # ============ 1. a brand-new visitor ============
        ctx, pg, errs = await fresh(b)
        await pg.goto(BASE + "/", wait_until="domcontentloaded")
        await settle(pg, 1200)
        chk("a first-time visitor to / lands on the launch site", path(pg).startswith("/welcome/"), path(pg))
        styled = await pg.evaluate("""()=>{const n=document.querySelector('.nav');
            return {css:[...document.styleSheets].some(s=>(s.href||'').endsWith('/welcome/css/site.css')),
                    nav: !!n && getComputedStyle(n).position !== 'static'};}""")
        chk("...fully styled (its css/ resolves under /welcome/)", styled["css"] and styled["nav"], styled)
        app_drawn = await pg.evaluate("()=>!!document.getElementById('chat')")
        chk("...and the app is not drawn behind it", not app_drawn)

        links = await pg.evaluate("""()=>[...document.querySelectorAll('[data-app]')].map(a=>({
            href:a.getAttribute('href'), target:a.getAttribute('target')||''}))""")
        chk("every 'Try Pixel Pro' button leads into the app's sign-in",
            links and all(l["href"] == "/?signin=1" for l in links), links)
        chk("...in the same tab, not a new one", links and all(l["target"] == "" for l in links), links)

        # ============ 1b. a quiet page ============
        # No intro to sit through, nothing that plays or narrates, nothing
        # moving by itself, no ElevenLabs studio: what is asked for is a
        # simple page that is just there.
        quiet = await pg.evaluate("""()=>({
            anims: document.getAnimations().length,
            media: document.querySelectorAll('audio,video,canvas,iframe').length,
            scripts: [...document.scripts].map(s=>s.src||'inline'),
            h1: document.querySelectorAll('h1').length,
            hscroll: document.documentElement.scrollWidth > innerWidth,
            cover: (()=>{const e=document.elementFromPoint(innerWidth/2, innerHeight/2); return e?e.closest('.hero')!==null:false;})(),
            fonts: getComputedStyle(document.querySelector('h1')).fontFamily + ' | ' + getComputedStyle(document.body).fontFamily})""")
        chk("the launch page opens straight onto its content -- no intro screen in the way", quiet["cover"], quiet)
        chk("...with nothing animating by itself", quiet["anims"] == 0, quiet["anims"])
        chk("...nothing that plays sound or video", quiet["media"] == 0, quiet["media"])
        chk("...only two small inline scripts (the /welcome fix and the offline cache)", quiet["scripts"] == ["inline", "inline"], quiet["scripts"])
        chk("...one headline, set in Instrument Serif, reading text in Inter",
            quiet["h1"] == 1 and quiet["fonts"].startswith('"Instrument Serif"') and '| Inter' in quiet["fonts"], quiet["fonts"])
        chk("...and no sideways scrolling on a phone", not quiet["hscroll"])
        site_files = []
        for root, _, files in os.walk(os.path.join(ROOT, "welcome")):
            site_files += [os.path.join(root, f) for f in files]
        voice = [os.path.relpath(f, ROOT) for f in site_files
                 if f.endswith((".html", ".js", ".css")) and
                 any(w in open(f, encoding="utf-8").read().lower() for w in ("elevenlabs", "voice studio", "narrat", "speechsynthesis"))]
        chk("no ElevenLabs, voice studio or narration left anywhere in the launch site", voice == [], voice)
        sw = open(os.path.join(ROOT, "welcome", "sw.js"), encoding="utf-8").read()
        import re as _re
        core = _re.search(r"CORE\s*=\s*\[([^\]]*)\]", sw).group(1)
        listed = [x.strip().strip("'\"") for x in core.split(",") if x.strip()]
        missing = [x for x in listed if x not in ("./",) and not os.path.exists(os.path.join(ROOT, "welcome", x))]
        chk("every file the launch site's offline cache lists really exists", listed and not missing, missing)

        # ============ 2. the button, clicked for real ============
        await pg.click(".nav [data-app]")
        await settle(pg, 1200)
        chk("'Try Pixel Pro' opens the app", path(pg).startswith("/?signin=1"), path(pg))
        gate = await pg.evaluate("()=>{const g=document.getElementById('gate'); return !!g && g.classList.contains('show');}")
        chk("...straight to the sign-in screen", gate, gate)

        # ============ 3. declining to sign in goes back ============
        await pg.click("#gateClose")
        await settle(pg, 900)
        chk("closing sign-in returns to the launch site", path(pg).startswith("/welcome/"), path(pg))

        # ============ 4. signing in ============
        await pg.goto(BASE + "/?signin=1", wait_until="domcontentloaded")
        await settle(pg, 900)
        await pg.click("#gateSignin")
        await settle(pg, 900)
        st = await pg.evaluate("""()=>({user: !!(state.user), flag: localStorage.getItem('pp-had-user'),
            gate: document.getElementById('gate').classList.contains('show'), search: location.search})""")
        chk("signing in enters the app", st["user"] and not st["gate"], st)
        chk("...remembers it for next time", st["flag"] == "1", st)
        chk("...and tidies ?signin=1 out of the address", st["search"] == "", st)
        chk("...and stays on the app", path(pg) == "/", path(pg))

        # ============ 5. coming back ============
        await pg.goto(BASE + "/", wait_until="domcontentloaded")
        await settle(pg, 900)
        chk("a returning signed-in visitor opens straight into the app", path(pg) == "/", path(pg))
        chk("...with the chat on screen", await pg.evaluate("()=>!!document.getElementById('chat')"))

        # ============ 6. signing out ============
        await pg.evaluate("()=>confirmSignOut()")
        await settle(pg, 1200)
        chk("signing out returns to the launch site", path(pg).startswith("/welcome/"), path(pg))
        chk("...and forgets the signed-in flag",
            await pg.evaluate("()=>localStorage.getItem('pp-had-user')") is None)
        chk("no JS errors in the journey", not errs, errs[:3])
        await ctx.close()

        # ============ 7. an expired session ============
        ctx, pg, errs = await fresh(b, init=SIGNED_IN_FLAG)    # flag says yes, Firebase says no
        await pg.goto(BASE + "/", wait_until="domcontentloaded")
        await settle(pg, 1500)
        chk("a stale 'signed in' flag is caught when Firebase answers",
            path(pg).startswith("/welcome/"), path(pg))
        await ctx.close()

        # ============ 8. still signed in, flag wiped (cleared storage) ============
        user = {"uid": "u1", "displayName": "Neelaksh", "email": "n@x.com", "photoURL": ""}
        ctx, pg, errs = await fresh(b, user=user)
        await pg.goto(BASE + "/?signin=1", wait_until="domcontentloaded")
        await settle(pg, 1200)
        st = await pg.evaluate("()=>({user:!!state.user, gate:document.getElementById('gate').classList.contains('show')})")
        chk("arriving to sign in while already signed in just enters the app",
            st["user"] and not st["gate"], st)
        await ctx.close()

        # ============ 9. /welcome without the slash ============
        # Netlify can serve a directory's index without redirecting to the
        # slash; relative css/ and js/ would then resolve against "/". Emulate
        # exactly that, and check the page repairs its own address.
        ctx, pg, errs = await fresh(b)
        landing = open(os.path.join(ROOT, "welcome", "index.html"), "rb").read()
        async def no_slash(route):
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=landing)
        await pg.route(BASE + "/welcome", no_slash)
        await pg.goto(BASE + "/welcome", wait_until="domcontentloaded")
        await settle(pg, 1200)
        chk("'/welcome' without the slash corrects itself to '/welcome/'",
            path(pg).startswith("/welcome/"), path(pg))
        css = await pg.evaluate("()=>[...document.styleSheets].some(s=>(s.href||'').endsWith('/welcome/css/site.css'))")
        chk("...and arrives styled", css)
        await ctx.close()

        print(json.dumps({"pass": len(P), "fail": len(F)}))
        for f in F: print("FAIL:", f)
        for s in P: print("pass:", s)
        await b.close()
        sys.exit(1 if F else 0)

asyncio.run(main())
