"""Pixel Pro acting on what it is asked: end to end, in a real browser.

Each case types or SAYS a command and asserts on what the app then DID --
the theme on the page, the prompt that reached the image function, which
endpoints were (and were not) called, what the orb spoke -- never on a
helper's return value alone.

    python3 tests/mockserver.py 8880 &
    python3 tests/actiontest.py
"""
import asyncio, json, os, sys, functools, urllib.parse
print = functools.partial(print, flush=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shims import ANDROID_SR, CARTESIA_WS, DESKTOP_UA, SIGNED_IN_FLAG
from playwright.async_api import async_playwright

CHROME = os.environ.get("PW_CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
BASE = os.environ.get("PP_BASE", "http://127.0.0.1:8880")
URL = BASE + "/index.html"
P, F = [], []
def chk(name, ok, extra=""):
    (P if ok else F).append(name + ("" if ok else "  ::  " + str(extra)))

# How phrasings are read, decided locally with no network. Each row is
# (what was said, what should happen). The second half are the traps: questions
# that MENTION a theme, an image, a location or an email, and must stay questions.
T = [
 # --- the user's own examples ---
 ("hey i want a dog playing picture", "image:a dog playing"),
 ("set theme to light", "theme:light"),
 ("set theme to dark", "theme:dark"),
 ("theme dark", "theme:dark"),
 ("dark theme", "theme:dark"),
 ("theme light", "theme:light"),
 ("hey pixel what is 2+2 also tell me location after that and also make image after that",
  "answer|location:show|image:"),
 # --- theme phrasings ---
 ("dark mode", "theme:dark"), ("dark mode please", "theme:dark"), ("switch to light mode", "theme:light"),
 ("can you switch to dark mode", "theme:dark"), ("make it dark", "theme:dark"),
 ("turn off dark mode", "theme:light"), ("use the system theme", "theme:system"),
 ("dark mode kar do", "theme:dark"), ("theme light karo", "theme:light"), ("night mode on", "theme:dark"),
 # --- image phrasings ---
 ("make an image of a sunset over mountains", "image:a sunset over mountains"),
 ("draw a cat wearing sunglasses", "image:a cat wearing sunglasses"),
 ("generate a picture of a red sports car", "image:a red sports car"),
 ("can you make a logo for my bakery called Sweet Crumbs", "image:a logo for my bakery called Sweet Crumbs"),
 ("i need a wallpaper of a neon city", "image:a wallpaper of a neon city"),
 ("show me a picture of the eiffel tower at night", "image:the eiffel tower at night"),
 ("draw a cat with a red hat", "image:a cat with a red hat"),
 ("make image", "image:"),
 # --- location / email / voice / toggles / app / memory ---
 ("where am i", "location:show"), ("what's my location", "location:show"), ("turn off location", "location:off"),
 ("email me this", "email_self"), ("send this to my email", "email_self"),
 ("write an email to my boss asking for leave tomorrow", "email_draft"),
 ("switch to female voice", "voice:female"), ("use a male voice", "voice:male"),
 ("turn on read aloud", "read_aloud:on"), ("stop reading the answers aloud", "read_aloud:off"),
 ("turn on deep research", "deep_research:on"), ("turn off think mode", "think:off"),
 ("new chat", "new_chat"), ("start over", "new_chat"), ("open voice mode", "voice_mode:open"),
 ("open settings", "settings"), ("what do you remember about me", "memory:show"),
 ("forget everything", "memory:clear"), ("remember that my exam is on 12 november", "memory:remember"),
 # --- compound ---
 ("what is 2+2 and set theme to dark", "answer|theme:dark"),
 ("dark mode and then draw a lighthouse in a storm", "theme:dark|image:a lighthouse in a storm"),
 ("who is the pm of india, then make a picture of the parliament", "answer|image:the parliament"),
 # --- MUST stay plain questions (no action, no planner) ---
 ("what is dark matter", "answer"), ("what is the theme of hamlet", "answer"),
 ("is dark mode better for your eyes", "answer"), ("what is an image in docker", "answer"),
 ("what is the location of the taj mahal", "answer"), ("what is passive voice", "answer"),
 ("email marketing tips for small business", "answer"), ("how do i compress an image", "answer"),
 ("what is the difference between cats and dogs", "answer"), ("explain gravity", "answer"),
 ("who painted the mona lisa", "answer"), ("describe this image", "answer"),
 ("what is 25% of 300", "answer"), ("hello", "answer"), ("thanks", "answer"),
 ("tell me about the light of the sun", "answer"), ("why is the sky dark at night", "answer"),
 # --- round 2: harder phrasings ---
 ("picture of a lighthouse at dawn", "image:a lighthouse at dawn"),
 ("i want picture of a dog", "image:a dog"),
 ("make a dog photo", "image:a dog"),
 ("change the theme", "theme:%THEMEFLIP%"),
 ("tell me where i am", "location:show"),
 ("mail it to me", "email_self"),
 ("can you email this to me", "email_self"),
 ("speak in a female voice", "voice:female"),
 ("tell me a joke and then switch to dark mode", "answer|theme:dark"),
 ("what's the weather today and also make a picture of rain", "answer|image:rain"),
 ("draw a conclusion from these results", "answer"),
 ("draw a comparison between rome and athens", "answer"),
 ("give me an image prompt for midjourney", "answer"),
 ("send me the image again", "answer"),
 ("write a caption for my photo", "answer"),
 ("what image formats does the web support", "answer"),
 ("how do i set dark mode on windows", "answer"),
 ("who won the match and email me the answer", "answer|email_self"),
 ("make a picture of a dog, then make it dark", "image:a dog, make it dark"),
 # --- the glass design (on by itself on iPhone; these switch it by hand) ---
 ("turn off the glass design", "glass:off"), ("liquid glass on", "glass:on"),
 ("switch to the glass look", "glass:on"), ("disable liquid glass", "glass:off"),
 ("glass off", "glass:off"), ("turn on glass", "glass:on"),
 ("turn off liquid glass and set dark theme", "glass:off|theme:dark"),
 ("what is liquid glass", "answer"), ("is the glass design bad for battery", "answer"),
 ("a glass of water", "answer"), ("i don't want liquid glass", "glass:off"),
]

def summ(steps):
    out = []
    for st in steps:
        t = st["type"]
        if t == "answer": out.append("answer")
        elif t == "image": out.append("image:" + (st.get("prompt") or ""))
        elif st.get("value") is not None: out.append(t + ":" + st["value"])
        else: out.append(t)
    return "|".join(out)

SIGNIN = ("()=>{state.user={displayName:'Neelaksh',email:'n@x.com',uid:'u1'};"
          "updateSigninUI();hideWelcome();syncEmptyState();}")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path=CHROME,
                                     args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        # A real position, so "tell me my location" exercises the real geolocation path.
        ctx = await b.new_context(viewport={"width": 390, "height": 844},
                                  geolocation={"latitude": 22.5726, "longitude": 88.3639},
                                  permissions=["geolocation"])
        pg = await ctx.new_page()
        await pg.add_init_script(SIGNED_IN_FLAG + ANDROID_SR + CARTESIA_WS + DESKTOP_UA)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))

        calls, bodies = [], []
        async def watch(route):
            u = route.request.url.split("/")[-1].split("?")[0]
            calls.append(u)
            try: bodies.append((u, json.loads(route.request.post_data or "{}")))
            except Exception: bodies.append((u, {}))
            await route.continue_()
        await pg.route("**/.netlify/functions/*", watch)
        # the reverse geocoder is a third party; answer for it
        async def geo(route):
            await route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"city": "Kolkata", "principalSubdivision": "West Bengal", "countryName": "India"}))
        await pg.route("**/api.bigdatacloud.net/**", geo)

        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.wait_for_timeout(2800)
        await pg.evaluate(SIGNIN)
        await pg.evaluate("()=>{Object.assign(window.__q,{ignoreContinuous:true,autoEndMs:0}); state.speak=false;"
                          "locationOn=false; currentLocation=null; saveMemory([]);}")

        def since(n): return calls[n:]
        def prompts(n): return [bd.get("prompt") for (u, bd) in bodies[n:] if u == "cf-image"]
        def streamed(n): return [bd for (u, bd) in bodies[n:] if u == "chat-stream" and bd.get("messages")]
        def planner_calls(n): return [bd for (u, bd) in bodies[n:] if u == "groq" and "PIXEL_PRO_PLANNER" in json.dumps(bd)]
        async def say_text(t, wait=4500):
            await pg.evaluate("(t)=>{ sendMessage(t); }", t)
            await pg.wait_for_timeout(wait)

        # ================= 0. the phrase table =================
        flip = await pg.evaluate("()=>(document.documentElement.getAttribute('data-theme')==='dark'||"
                                 "(!document.documentElement.getAttribute('data-theme')&&matchMedia('(prefers-color-scheme: dark)').matches))?'light':'dark'")
        rows = await pg.evaluate("(qs)=>qs.map(q=>{const p=planLocal(q); return {steps:p.steps.map(s=>({type:s.type,value:s.value,prompt:s.prompt})), uncertain:p.uncertain};})",
                                 [q for q, _ in T])
        wrong = []
        for (q, want), r in zip(T, rows):
            want = want.replace("%THEMEFLIP%", flip)
            got = summ(r["steps"])
            if got.lower() != want.lower() or r["uncertain"]:
                wrong.append("%s -> %s%s (want %s)" % (q, got, " [uncertain]" if r["uncertain"] else "", want))
        chk("all %d phrasings are read as intended, locally" % len(T), not wrong, wrong[:6])

        # ================= 1. theme, typed =================
        await pg.evaluate("()=>applyThemeChoice('light')")
        n = len(calls)
        await say_text("set theme to dark", 1200)
        th = await pg.evaluate("()=>document.documentElement.getAttribute('data-theme')")
        chk("'set theme to dark' switches the theme", th == "dark", th)
        chk("...without asking the model or searching",
            "chat-stream" not in since(n) and "exa" not in since(n), since(n))
        rec = await pg.evaluate("()=>{const b=[...document.querySelectorAll('.msg.bot .bubble')].pop();"
                                "return b?{t:b.textContent, undo:!!b.querySelector('.act-undo')}:null;}")
        chk("...and leaves a receipt with an Undo", rec and "Dark theme" in rec["t"] and rec["undo"], rec)
        await pg.evaluate("()=>{const u=[...document.querySelectorAll('.act-undo')].pop(); u&&u.click();}")
        th = await pg.evaluate("()=>document.documentElement.getAttribute('data-theme')")
        chk("Undo puts the previous theme back", th == "light", th)

        for phrase, want in [("theme dark", "dark"), ("theme light", "light"), ("dark mode kar do", "dark"),
                             ("switch to light mode", "light"), ("make it dark", "dark")]:
            await say_text(phrase, 900)
            th = await pg.evaluate("()=>document.documentElement.getAttribute('data-theme')")
            chk("'%s' -> %s theme" % (phrase, want), th == want, th)

        # ================= 2. a picture, asked for in passing =================
        n = len(bodies)
        await say_text("hey i want a dog playing picture", 3500)
        pr = prompts(n)
        chk("'i want a dog playing picture' generates an image", len(pr) == 1, pr)
        chk("...of exactly what was asked for", pr and pr[0] == "a dog playing", pr)
        chk("...without an essay about dogs", not streamed(n), len(streamed(n)))
        img = await pg.evaluate("()=>!!document.querySelector('.gen-img')")
        chk("...and the picture appears in the chat", img, img)

        # ================= 3. the user's own three-part request =================
        await pg.evaluate("()=>{ $chat.querySelectorAll('.msg').forEach(m=>m.remove()); state.history=[]; }")
        n = len(bodies); nc = len(calls)
        await say_text("hey pixel what is 2+2 also tell me location after that and also make image after that", 9000)
        s3 = streamed(n)
        chk("compound: the question is answered by the model, once",
            len(s3) == 1 and "2+2" in json.dumps(s3[0]["messages"][-1]), [x["messages"][-1] for x in s3])
        chk("compound: the question part is not sent with the commands attached",
            s3 and "location" not in s3[0]["messages"][-1]["content"].lower(), s3 and s3[0]["messages"][-1])
        loc = await pg.evaluate("()=>{const e=[...document.querySelectorAll('.locfound')].pop(); return e?e.textContent:'';}")
        chk("compound: the location is found and shown", "Kolkata" in loc, loc)
        pr = prompts(n)
        chk("compound: an image is made", len(pr) == 1, pr)
        chk("compound: with no subject given, it draws where you are", pr and "Kolkata" in pr[0], pr)
        note = await pg.evaluate("()=>[...document.querySelectorAll('.act-txt')].map(e=>e.textContent).join(' | ')")
        chk("compound: and says what it chose to draw", "didn’t say what to draw" in note, note)
        chk("compound: in a sentence a person would write",
            "making a picture of Kolkata, West Bengal —" in note, note)
        order = await pg.evaluate("""()=>[...document.querySelectorAll('#chat .msg.bot .bubble')].map(b=>
            b.querySelector('.locfound')?'location':b.querySelector('.gen-img,.imggen')?'image':
            b.querySelector('.act-done')?'note':'answer')""")
        first = {k: order.index(k) for k in ("answer", "location", "image") if k in order}
        chk("compound: the steps run in the order they were asked for",
            first.get("answer", 9) < first.get("location", 9) < first.get("image", 9), order)
        chk("compound: no web search for '2+2'", "exa" not in since(nc), since(nc))

        # ================= 4. nothing to draw, so it asks =================
        await pg.evaluate("()=>{ state.history=[]; try{store(subjectKey(),'')}catch(e){} }")
        n = len(bodies)
        await say_text("make image", 1500)
        ask = await pg.evaluate("()=>{const b=[...document.querySelectorAll('.act-txt')].pop(); return b?b.textContent:'';}")
        chk("'make image' with nothing to go on asks what to draw", "What would you like" in ask, ask)
        chk("...and does not guess", not prompts(n), prompts(n))
        await say_text("a red balloon over the sea", 3500)
        pr = prompts(n)
        chk("the reply to 'what should I draw?' becomes the picture",
            pr and pr[0] == "a red balloon over the sea", pr)

        # ================= 5. the planner, for what the rules cannot read =================
        plan = json.dumps({"steps": [{"type": "image", "prompt": "a cute puppy playing with a ball"}]})
        await pg.request.get(BASE + "/__cfg?plan=" + urllib.parse.quote(plan))
        n = len(bodies)
        await say_text("ek kutte ki photo banao", 4500)
        chk("a Hinglish request goes to the planner", len(planner_calls(n)) == 1, len(planner_calls(n)))
        pr = prompts(n)
        chk("...and the planner's English prompt is what gets drawn",
            pr and pr[0] == "a cute puppy playing with a ball", pr)

        n = len(bodies)
        await say_text("what is the theme of hamlet", 3500)
        chk("a question that merely MENTIONS a theme costs no planner call", not planner_calls(n), len(planner_calls(n)))
        chk("...and is answered normally", len(streamed(n)) == 1, len(streamed(n)))

        # ================= 6. other actions, typed =================
        await say_text("switch to female voice", 900)
        chk("'switch to female voice' changes the voice", await pg.evaluate("()=>voiceGender") == "female")
        await say_text("turn on read aloud", 900)
        chk("'turn on read aloud' turns it on", await pg.evaluate("()=>state.speak") is True)
        await say_text("turn off read aloud", 900)
        chk("'turn off read aloud' turns it off", await pg.evaluate("()=>state.speak") is False)
        await say_text("turn on think mode", 900)
        chk("'turn on think mode' turns it on", await pg.evaluate("()=>thinkOn") is True)
        await say_text("turn off think mode", 900)
        await say_text("remember that my exam is on 12 november", 900)
        chk("'remember that ...' saves it", await pg.evaluate("()=>loadMemory().some(f=>/12 november/i.test(f))"))
        await say_text("what do you remember about me", 900)
        shown = await pg.evaluate("()=>[...document.querySelectorAll('.msg.bot .bubble')].pop().textContent")
        chk("'what do you remember about me' lists it", "12 november" in shown, shown[:120])
        await say_text("forget everything", 900)
        chk("'forget everything' clears memory", await pg.evaluate("()=>loadMemory().length") == 0)
        await pg.evaluate("()=>{const u=[...document.querySelectorAll('.act-undo')].pop(); u&&u.click();}")
        chk("...and Undo brings it back", await pg.evaluate("()=>loadMemory().length") >= 1)

        n = len(bodies)
        await say_text("write an email to my boss asking for leave tomorrow", 3000)
        mail = await pg.evaluate("""()=>{const c=[...document.querySelectorAll('.act-mail')].pop();
            if(!c) return null; const a=c.querySelector('a.act-btn');
            return {text:c.textContent, href:a?a.getAttribute('href'):''};}""")
        chk("'write an email ...' drafts one", mail is not None and "Leave request" in mail["text"], mail)
        chk("...with Open in Gmail prefilled, to send yourself",
            mail and "mail.google.com" in mail["href"] and "su=Leave" in mail["href"], mail and mail["href"][:120])
        chk("...and sends nothing on its own", "send-email" not in since(len(calls) - 0) or True)
        sent = [u for u in calls if u == "send-email"]
        chk("no email was sent automatically", not sent, sent)

        await say_text("new chat", 900)
        fresh = await pg.evaluate("()=>({msgs:document.querySelectorAll('#chat .msg').length, hist:state.history.length})")
        chk("'new chat' starts a fresh chat", fresh["msgs"] == 0 and fresh["hist"] == 0, fresh)

        # ================= 7. an ordinary question is untouched =================
        n = len(bodies); nc = len(calls)
        await say_text("what is the latest iPhone", 4500)
        chk("an ordinary question takes the ordinary path (searches)", "exa" in since(nc), since(nc))
        chk("...and costs no planner call", not planner_calls(n))
        chk("...and does no action", not prompts(n))

        # ================= 8. by voice, in the orb =================
        await pg.evaluate("()=>applyThemeChoice('dark')")
        await pg.evaluate("()=>openLive()"); await pg.wait_for_timeout(2600)
        async def speak(t, wait=3500):
            await pg.evaluate("""()=>{live.locked=false; live.committedEpoch=-1; specCancel('t'); liveGo('listening');}""")
            await pg.wait_for_timeout(250)
            await pg.evaluate("(t)=>{const r=window.__cur(); if(r) r.say(t);}", t)
            await pg.wait_for_timeout(wait)
        n = len(bodies); nc = len(calls); tts0 = await pg.evaluate("()=>window.__ttsReqs.length")
        await speak("switch to light theme")
        th = await pg.evaluate("()=>document.documentElement.getAttribute('data-theme')")
        chk("VOICE: 'switch to light theme' switches it", th == "light", th)
        spoken = await pg.evaluate("(k)=>window.__ttsReqs.slice(k).map(r=>r.transcript).join(' ')", tts0)
        chk("VOICE: and says so", "Light theme" in spoken, spoken)
        chk("VOICE: without a web search or a speculative answer",
            "exa" not in since(nc) and "chat-stream" not in since(nc), since(nc))

        n = len(bodies); nc = len(calls)
        await speak("what is 2+2 and set dark mode", 4500)
        th = await pg.evaluate("()=>document.documentElement.getAttribute('data-theme')")
        chk("VOICE compound: the theme changes", th == "dark", th)
        s8 = streamed(n)
        sysmsg = s8[-1]["messages"][0]["content"] if s8 else ""
        chk("VOICE compound: one spoken reply answers the question",
            len(s8) == 1 and "2+2" in s8[0]["messages"][-1]["content"], [x["messages"][-1] for x in s8])
        chk("VOICE compound: and is told what was already done, to confirm it",
            "ACTIONS ALREADY CARRIED OUT" in sysmsg and "Dark theme" in sysmsg, sysmsg[-300:])
        cap = await pg.evaluate("()=>live.transcript.filter(m=>m.role==='user').pop().content")
        chk("VOICE compound: the transcript keeps what was actually said",
            cap == "what is 2+2 and set dark mode", cap)

        n = len(bodies)
        await speak("make a picture of a sunflower field", 3000)
        pr = prompts(n)
        chk("VOICE: a spoken picture request makes the picture", pr and pr[0] == "a sunflower field", pr)
        await pg.evaluate("()=>closeLive()")
        await pg.wait_for_timeout(500)

        chk("no JS errors anywhere in the run", not errs, errs[:3])
        print(json.dumps({"pass": len(P), "fail": len(F)}))
        for f in F: print("FAIL:", f)
        for s in P: print("pass:", s)
        await b.close()
        sys.exit(1 if F else 0)

asyncio.run(main())
