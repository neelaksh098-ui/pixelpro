"""End-to-end checks for the Live Orb, the live-web pipeline and the status UI.

Every case drives the real app in a real browser: a spoken utterance goes
into the recogniser shim and the assertions are made on what the app did --
which endpoints it called, what it put on screen, what it sent the model.
No assertion here calls an internal helper in isolation.

    python3 tests/mockserver.py 8880 &
    python3 tests/orbtest.py
"""
import asyncio, json, os, sys, functools
print = functools.partial(print, flush=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shims import ANDROID_SR, CARTESIA_WS, DESKTOP_UA
from playwright.async_api import async_playwright

CHROME = os.environ.get("PW_CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
URL = os.environ.get("PP_URL", "http://127.0.0.1:8880/index.html")

P, F = [], []
def chk(name, ok, extra=""):
    (P if ok else F).append(name + ("" if ok else "  ::  " + str(extra)))

SIGNIN = ("()=>{state.user={displayName:'Neelaksh',email:'n@x.com',uid:'u1'};"
          "updateSigninUI();hideWelcome();syncEmptyState();}")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path=CHROME,
                                     args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        ctx = await b.new_context(viewport={"width": 390, "height": 844})
        pg = await ctx.new_page()
        await pg.add_init_script(ANDROID_SR + CARTESIA_WS + DESKTOP_UA)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))

        calls = []
        bodies = []
        async def watch(route):
            u = route.request.url.split("/")[-1]
            calls.append(u)
            if u in ("chat-stream", "groq"):
                try: bodies.append((u, json.loads(route.request.post_data or "{}")))
                except Exception: bodies.append((u, {}))
            await route.continue_()
        await pg.route("**/.netlify/functions/*", watch)

        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.wait_for_timeout(3000)
        await pg.evaluate(SIGNIN)
        await pg.evaluate("()=>{Object.assign(window.__q,{ignoreContinuous:true,autoEndMs:0});}")

        # ---------- 1. the theme is actually black ----------
        await pg.evaluate("()=>{document.documentElement.setAttribute('data-theme','dark');}")
        # body carries `transition:background-color .2s`, so a reading taken
        # straight away catches the colour mid-animation and is simply wrong.
        await pg.wait_for_timeout(600)
        theme = await pg.evaluate("""()=>{
            const cs=getComputedStyle(document.body);
            const rs=getComputedStyle(document.documentElement);
            return {body:cs.backgroundColor, ink:rs.getPropertyValue('--ink').trim(),
                    bg:rs.getPropertyValue('--bg').trim(), bg2:rs.getPropertyValue('--bg-2').trim()};}""")
        chk("dark theme paints the page pure black",
            theme["body"].replace(" ", "") == "rgb(0,0,0)", theme)
        chk("dark theme's --bg and --bg-2 are both #000",
            theme["bg"].lower() == "#000000" and theme["bg2"].lower() == "#000000", theme)
        chk("dark theme text is pure white", theme["ink"].lower() == "#ffffff", theme)
        mark = await pg.evaluate("""()=>{
            const el=document.querySelector('.mark span:nth-child(5)');
            return el ? getComputedStyle(el).backgroundColor : null;}""")
        chk("the logo mark goes white in the dark theme",
            mark is None or mark.replace(" ", "") in ("rgb(255,255,255)",), mark)
        await pg.evaluate("()=>{document.documentElement.setAttribute('data-theme','light');}")

        # ---------- 2. nothing in the UI says "searching" ----------
        # Comments are stripped first. A check that scans raw source matches
        # the prose explaining why a string was removed, which is a test of
        # spelling rather than of behaviour.
        src = await (await pg.request.get(URL)).text()
        import re as _re
        code = _re.sub(r"/\*.*?\*/", " ", src, flags=_re.S)
        bad = [s for s in ["Searching live web", "Searching the live web", "Live web search",
                           "Searching the web"] if s in code]
        chk("no status string announces the search mechanism", not bad, bad)

        # ---------- 3. a text-mode live turn: globe, count, favicons ----------
        calls.clear(); bodies.clear()
        await pg.evaluate("()=>{state.history=[]; state.speak=false;}")
        # Hold the search long enough that the thinking row can be read while
        # it is on screen. The row is the thing under test; a search that
        # returns in 300ms means there is nothing left to look at by the time
        # the assertion runs.
        await pg.request.get("http://127.0.0.1:8880/__cfg?exa_ms=1200&ttft=2500")
        # sendMessage is async, so evaluating it as an expression would make
        # Playwright await the WHOLE turn and every assertion below would run
        # after it finished -- including the ones about what is on screen
        # while it is still running.
        await pg.evaluate("()=>{ sendMessage('what is the latest iPhone'); }")
        await pg.wait_for_timeout(2200)
        mid = await pg.evaluate("""()=>{
            const t=document.getElementById('thinking');
            if(!t) return null;
            return {txt:t.textContent, globe:!!t.querySelector('.think2-globe svg'),
                    favs:t.querySelectorAll('.favs .fav').length,
                    dot:(document.querySelector('.think2-dot')||{}).style ?
                        document.querySelector('.think2-dot').style.display : ''};}""")
        chk("the thinking row says 'Thinking' on a web turn",
            mid is not None and "Thinking" in mid["txt"], mid)
        chk("...and never the word 'Searching'",
            mid is not None and "Searching" not in mid["txt"], mid)
        chk("...shows a round web globe", mid is not None and mid["globe"] is True, mid)
        chk("...hides the plain pulsing dot", mid is not None and mid["dot"] == "none", mid)
        chk("...reports the number of sources",
            mid is not None and ("source" in mid["txt"]), mid)
        chk("...with a small favicon per source",
            mid is not None and mid["favs"] >= 1, mid)

        await pg.request.get("http://127.0.0.1:8880/__cfg?exa_ms=300&ttft=180")
        await pg.wait_for_timeout(7000)
        fin = await pg.evaluate("""()=>{
            const b=[...document.querySelectorAll('.msg.bot .bubble')].pop();
            if(!b) return null;
            return {chip:(b.querySelector('.web-chip')||{}).textContent||'',
                    chipGlobe:!!b.querySelector('.web-chip svg'),
                    chipFavs:b.querySelectorAll('.web-chip .fav').length,
                    srcFavs:b.querySelectorAll('.sources .fav').length,
                    doms:[...b.querySelectorAll('.sources .dom')].map(e=>e.textContent),
                    text:b.textContent.slice(0,60)};}""")
        chk("the finished answer carries a globe, not a sentence",
            fin is not None and fin["chipGlobe"] and "Searched on live web" not in fin["chip"], fin)
        chk("the chip counts the sources",
            fin is not None and "source" in fin["chip"], fin and fin["chip"])
        chk("the chip shows favicons", fin is not None and fin["chipFavs"] >= 1, fin)
        chk("each source row shows its favicon", fin is not None and fin["srcFavs"] >= 1, fin)
        chk("each source row leads with the domain",
            fin is not None and any("apple.com" in d for d in fin["doms"]), fin and fin["doms"])
        chk("the live turn actually searched", "exa" in calls, calls)
        streamed = [bd for (u, bd) in bodies if u == "chat-stream" and bd.get("messages")]
        chk("the model was given the evidence",
            bool(streamed) and len(str(streamed[-1].get("liveContext", ""))) > 200,
            len(str(streamed[-1].get("liveContext", ""))) if streamed else 0)

        # ---------- 4. a basic question stays off the web ----------
        calls.clear()
        await pg.evaluate("()=>{ sendMessage('what is python'); }")
        await pg.wait_for_timeout(4000)
        chk("a basic question calls no search provider",
            "exa" not in calls and "tavily" not in calls, calls)
        basic = await pg.evaluate("""()=>{
            const b=[...document.querySelectorAll('.msg.bot .bubble')].pop();
            return b ? {chip:!!b.querySelector('.web-chip'), srcs:!!b.querySelector('.sources')} : null;}""")
        chk("...and shows no globe or sources on the answer",
            basic is not None and not basic["chip"] and not basic["srcs"], basic)

        # ---------- 5. THE LIVE ORB, end to end ----------
        calls.clear(); bodies.clear()
        await pg.evaluate("()=>openLive()")
        await pg.wait_for_timeout(2600)
        chk("the orb opens", await pg.evaluate("()=>!!live.on"))
        chk("...and warms the TTS socket before anything is spoken",
            await pg.evaluate("()=>window.__wsOpens") >= 1,
            await pg.evaluate("()=>window.__wsOpens"))

        await pg.evaluate("""()=>{live.locked=false; live.committedEpoch=-1; live.transcript=[];
            lastLiveEvidence={context:'',query:'',at:0}; specCancel('t'); liveGo('listening');}""")
        await pg.wait_for_timeout(250)
        await pg.evaluate("()=>{const r=window.__cur(); if(r) r.say('what is the latest iPhone');}")
        # watch the status while it works
        seen = await pg.evaluate("""async()=>{
            const out=[];
            for(let i=0;i<120;i++){
                const s=document.getElementById('liveStatus');
                if(s && s.textContent) out.push(live.state+'|'+s.textContent);
                if(live.transcript.some(m=>m.role==='assistant')) break;
                await new Promise(r=>setTimeout(r,50));
            }
            return [...new Set(out)];}""")
        await pg.wait_for_timeout(400)
        orb = await pg.evaluate("""()=>({
            turns:live.transcript.length,
            answer:(live.transcript.filter(m=>m.role==='assistant')[0]||{}).content||'',
            srcCount:live.srcCount||0,
            ttsReqs:window.__ttsReqs.length,
            trace:JSON.parse(JSON.stringify(window.turnTimings[0]||{}))})""")
        chk("the orb answers a live-web question", bool(orb["answer"]), orb)
        chk("...having actually searched", "exa" in calls, calls)
        chk("...grounded in the evidence",
            any(len(str(bd.get("liveContext", ""))) > 200
                for (u, bd) in bodies if u == "chat-stream"),
            [(u, len(str(bd.get("liveContext", "")))) for (u, bd) in bodies if u == "chat-stream"])
        chk("...and spoke it through the TTS socket", orb["ttsReqs"] >= 1, orb["ttsReqs"])
        chk("the orb status never says 'Searching'",
            not any("Searching" in s for s in seen), seen)
        chk("the orb status says 'Thinking' while it works",
            any("Thinking" in s for s in seen), seen)
        chk("the orb status reports the source count",
            any("source" in s for s in seen), seen)
        chk("the turn trace names the route",
            orb["trace"].get("route") == "LIVE_SEARCH", orb["trace"].get("route"))
        chk("the turn trace records no failure",
            orb["trace"].get("failure") in (None, {}), orb["trace"].get("failure"))

        # a second spoken turn in the same session must behave the same
        calls.clear()
        await pg.evaluate("""()=>{live.locked=false; live.committedEpoch=-1; specCancel('t'); liveGo('listening');}""")
        await pg.wait_for_timeout(250)
        await pg.evaluate("()=>{const r=window.__cur(); if(r) r.say('and what about the price of gold today');}")
        await pg.evaluate("""async()=>{ for(let i=0;i<160;i++){
            if(live.transcript.filter(m=>m.role==='assistant').length>=2) return;
            await new Promise(r=>setTimeout(r,50)); } }""")
        two = await pg.evaluate("()=>live.transcript.filter(m=>m.role==='assistant').length")
        chk("a second spoken turn answers too", two >= 2, two)
        chk("...and it ran its own search rather than reusing stale evidence",
            "exa" in calls, calls)

        chk("no JS errors anywhere in the run", not errs, errs[:3])
        print(json.dumps({"pass": len(P), "fail": len(F)}))
        for f in F: print("FAIL:", f)
        for s in P: print("pass:", s)
        await b.close()
        sys.exit(1 if F else 0)

asyncio.run(main())
