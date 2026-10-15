"""The Liquid Glass design: on by itself on iPhone and iPad, nowhere else.

Every check reads what the browser actually computed and drew -- the class on
<html>, the backdrop-filter on the composer, where #main really starts and
ends, which element really sits under the composer -- and the "nothing else
changed" checks compare screenshots of this build against the committed one
(or PP_BASELINE=<commit>), pixel by pixel, on Android and on a laptop.

    python3 tests/mockserver.py 8880 &
    python3 tests/glasstest.py            (screenshots go to $PP_SHOTS if set)
"""
import asyncio, base64, json, os, subprocess, sys, functools
print = functools.partial(print, flush=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shims import SIGNED_IN_FLAG
from playwright.async_api import async_playwright

CHROME = os.environ.get("PW_CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
BASE = os.environ.get("PP_BASE", "http://127.0.0.1:8880")
URL = BASE + "/index.html"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("PP_SHOTS", "")
P, F = [], []
def chk(name, ok, extra=""):
    (P if ok else F).append(name + ("" if ok else "  ::  " + str(extra)))

def ua(s, platform, touch):
    return ("Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=>%s});"
            "Object.defineProperty(navigator,'platform',{configurable:true,get:()=>%s});"
            "Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,get:()=>%d});"
            % (json.dumps(s), json.dumps(platform), touch))

IPHONE = ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1", "iPhone", 5)
IPHONE_CHROME = ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 "
                   "(KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1", "iPhone", 5)
IPAD = ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
          "(KHTML, like Gecko) Version/18.6 Safari/605.1.15", "MacIntel", 5)
MAC = ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
         "(KHTML, like Gecko) Version/18.6 Safari/605.1.15", "MacIntel", 0)
ANDROID = ua("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", "Linux armv8l", 5)
WINDOWS = ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", "Win32", 0)

SIGNIN = ("()=>{state.user={displayName:'Neelaksh',email:'n@x.com',uid:'u1'};"
          "updateSigninUI();hideWelcome();syncEmptyState();}")
# A conversation long enough to scroll, made of the app's own message elements.
FILL = """()=>{
  $hero.style.display='none';
  for(let i=0;i<9;i++){
    addMessage('user', esc('Question number '+(i+1)+' about the solar system'));
    addMessage('bot', md('**Answer '+(i+1)+'.** The Sun holds 99.8% of the mass of the solar system. '+
      'Jupiter is the largest planet, and Saturn has the most visible rings. Light from the Sun '+
      'takes about eight minutes to reach Earth.'));
  }
  syncEmptyState();
}"""

# The build the "nothing else changed" screenshots are compared against: the
# committed one by default (so run this before committing a change), or any
# commit named in PP_BASELINE.
BASELINE = os.environ.get("PP_BASELINE", "HEAD")
try:
    OLD_HTML = subprocess.run(["git", "-C", ROOT, "show", BASELINE + ":index.html"],
                              capture_output=True, check=True).stdout
except Exception:
    OLD_HTML = None

async def page(b, init, vw=390, vh=844, old=False, query=""):
    ctx = await b.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=1,
                              has_touch=True)
    if old and OLD_HTML is not None:
        async def serve_old(route):
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=OLD_HTML)
        await ctx.route("**/index.html*", serve_old)
    await ctx.add_init_script(SIGNED_IN_FLAG + init +
                              "try{localStorage.setItem('pp-theme-choice','light')}catch(e){}")
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(URL + query, wait_until="domcontentloaded")
    await pg.wait_for_timeout(1600)
    await pg.evaluate(SIGNIN)
    await pg.wait_for_timeout(250)
    return ctx, pg, errs

GEOM = """()=>{
  const r=e=>e?e.getBoundingClientRect():null, cs=e=>getComputedStyle(e);
  const main=document.getElementById('main'), top=document.querySelector('header.top'),
        wrap=document.querySelector('.composer-wrap'), pill=document.getElementById('pill');
  return {glass: document.documentElement.classList.contains('liquid-glass'),
    mainTop:r(main).top, mainBottom:r(main).bottom, topH:top.offsetHeight, topBottom:r(top).bottom,
    wrapTop:r(wrap).top, wrapH:wrap.offsetHeight, vh:innerHeight,
    padTop:parseFloat(cs(main).paddingTop), padBottom:parseFloat(cs(main).paddingBottom),
    pillBlur:(cs(pill).backdropFilter||cs(pill).webkitBackdropFilter||''),
    pillBg:cs(pill).backgroundColor, pillImg:cs(pill).backgroundImage,
    topBg:cs(top).backgroundImage, topBgColor:cs(top).backgroundColor,
    wrapBg:cs(wrap).backgroundImage, wrapBgColor:cs(wrap).backgroundColor,
    lgTop:document.documentElement.style.getPropertyValue('--lg-top'),
    lgBottom:document.documentElement.style.getPropertyValue('--lg-bottom')};
}"""

# what really lies under a point: the stacking order the browser hit-tests with
UNDER = """([x,y])=>document.elementsFromPoint(x,y).map(e=>e.id||e.className||e.tagName).map(String)"""

async def shot_b64(pg):
    return base64.b64encode(await pg.screenshot()).decode()

# The laptop's icon rail (the left 68px) differs between two loads of the SAME
# build -- its icons rasterise slightly differently run to run -- so the
# comparison can be told to skip that strip; everything else must match exactly.
DIFF = """async ([a,b,skipLeft])=>{
  const load=src=>new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src='data:image/png;base64,'+src;});
  const [A,B]=await Promise.all([load(a),load(b)]);
  if(A.width!==B.width||A.height!==B.height) return {size:true,diff:-1};
  const c=document.createElement('canvas');c.width=A.width;c.height=A.height;
  const x=c.getContext('2d');x.drawImage(A,0,0);const da=x.getImageData(0,0,c.width,c.height).data;
  x.clearRect(0,0,c.width,c.height);x.drawImage(B,0,0);const db=x.getImageData(0,0,c.width,c.height).data;
  let n=0;for(let i=0;i<da.length;i+=4){if((i/4)%c.width<(skipLeft||0))continue;
    if(da[i]!==db[i]||da[i+1]!==db[i+1]||da[i+2]!==db[i+2])n++;}
  return {size:false,diff:n,total:da.length/4};
}"""

async def save(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        await pg.screenshot(path=os.path.join(SHOTS, name))

async def main():
    async with async_playwright() as pw:
        # SwiftShader's GPU path, because the default headless compositor draws
        # backdrop-filter as a faint wash rather than a blur -- the screenshots
        # would understate the glass. With it, blur renders as Safari draws it.
        b = await pw.chromium.launch(executable_path=CHROME, args=[
            "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])

        # ============ 1. who gets it ============
        for label, init, want in [("iPhone Safari", IPHONE, True), ("iPhone Chrome", IPHONE_CHROME, True),
                                  ("iPad (reports as a Mac)", IPAD, True), ("a real Mac", MAC, False),
                                  ("Android", ANDROID, False), ("Windows", WINDOWS, False)]:
            ctx, pg, errs = await page(b, init)
            g = await pg.evaluate(GEOM)
            chk(label + (" gets the glass design" if want else " keeps the normal design"),
                g["glass"] == want, g["glass"])
            chk(label + ": no page errors", not errs, errs)
            await ctx.close()

        # ============ 2. iPhone: it is really glass, and really over the chat ============
        ctx, pg, errs = await page(b, IPHONE)
        await save(pg, "glass-iphone-newchat.png")
        await pg.evaluate("()=>applyThemeChoice('dark')")
        await pg.wait_for_timeout(300)
        await save(pg, "glass-iphone-newchat-dark.png")
        await pg.evaluate("()=>{document.getElementById('liveOverlay').style.display='flex';}")
        await pg.wait_for_timeout(400)
        lc = await pg.evaluate("()=>{const c=getComputedStyle(document.getElementById('liveClose'));return c.backdropFilter||c.webkitBackdropFilter;}")
        chk("the voice orb's buttons are glass", "blur(" in (lc or ""), lc)
        await save(pg, "glass-iphone-orb-dark.png")
        await pg.evaluate("()=>{document.getElementById('liveOverlay').style.display=''; applyThemeChoice('light');}")
        await pg.wait_for_timeout(300)
        g = await pg.evaluate(GEOM)
        chk("the composer pill blurs what is behind it", "blur(" in g["pillBlur"] and "saturate(" in g["pillBlur"], g["pillBlur"])
        chk("...through a translucent fill, not a solid one", g["pillBg"].startswith("rgba(") and not g["pillBg"].endswith(", 1)"), g["pillBg"])
        chk("...with a sheen on its face", "linear-gradient" in g["pillImg"], g["pillImg"])
        chk("the header fades into the page instead of being a solid bar",
            "linear-gradient" in g["topBg"] and g["topBgColor"] in ("rgba(0, 0, 0, 0)", "transparent"), (g["topBg"], g["topBgColor"]))
        chk("the strip under the composer is a fade, not a solid band",
            "linear-gradient" in g["wrapBg"] and g["wrapBgColor"] in ("rgba(0, 0, 0, 0)", "transparent"), (g["wrapBg"], g["wrapBgColor"]))
        chk("the chat starts at the very top, under the header", abs(g["mainTop"]) <= 1, g)
        chk("...and ends at the very bottom, under the composer", abs(g["mainBottom"] - g["vh"]) <= 1, g)
        chk("...padded by exactly the header's height", abs(g["padTop"] - g["topH"]) <= 1, g)
        chk("...and by exactly the composer's height", abs(g["padBottom"] - g["wrapH"]) <= 1, g)

        await pg.evaluate(FILL)
        await pg.wait_for_timeout(500)
        await pg.evaluate("()=>{const m=document.getElementById('main'); m.style.scrollBehavior='auto'; m.scrollTop=m.scrollHeight;}")
        await pg.wait_for_timeout(200)
        # newest message, scrolled to the end: fully above the composer, not hidden by it
        end = await pg.evaluate("""()=>{const m=[...document.querySelectorAll('#chat .msg')].pop();
            const w=document.getElementById('pill').getBoundingClientRect();
            return {msgBottom:m.getBoundingClientRect().bottom, pillTop:w.top};}""")
        chk("scrolled to the end, the newest reply sits fully above the composer",
            end["msgBottom"] <= end["pillTop"], end)
        await save(pg, "glass-iphone-light.png")
        # scroll up a little: now a message really is under the composer and under the header
        await pg.evaluate("()=>{const m=document.getElementById('main'); m.style.scrollBehavior='auto'; m.scrollTop=m.scrollTop-260;}")
        await pg.wait_for_timeout(200)
        pill = await pg.evaluate("()=>{const r=document.getElementById('pill').getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2];}")
        under_pill = await pg.evaluate(UNDER, pill)
        chk("mid-scroll, chat text really passes behind the composer glass",
            any("bubble" in x or x.startswith("msg") for x in under_pill), under_pill[:8])
        chk("...and the composer is on top of it, still the thing you tap",
            under_pill and ("pill" in under_pill[0] or "input" == under_pill[0] or "composer" in under_pill[0]), under_pill[:3])
        hdr = await pg.evaluate("()=>{const r=document.getElementById('menuBtn').getBoundingClientRect();return [r.right+40, r.top+r.height/2];}")
        under_hdr = await pg.evaluate(UNDER, hdr)
        chk("...and behind the header", any("bubble" in x or x.startswith("msg") for x in under_hdr), under_hdr[:8])
        menu_hit = await pg.evaluate("()=>{const r=document.getElementById('menuBtn').getBoundingClientRect();"
                                     "return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2).closest('#menuBtn')!==null;}")
        chk("the header buttons stay tappable over the chat", menu_hit)
        await save(pg, "glass-iphone-light-midscroll.png")

        # ============ 3. heights move, the layout follows ============
        before = await pg.evaluate(GEOM)
        await pg.fill("#input", "line one\nline two\nline three\nline four")
        await pg.dispatch_event("#input", "input")
        await pg.wait_for_timeout(300)
        after = await pg.evaluate(GEOM)
        chk("a taller composer pushes the chat's bottom padding with it",
            after["wrapH"] > before["wrapH"] and abs(after["padBottom"] - after["wrapH"]) <= 1, (before["wrapH"], after["wrapH"], after["padBottom"]))
        await pg.fill("#input", "")
        await pg.dispatch_event("#input", "input")
        await pg.evaluate("()=>{const s=document.getElementById('stopBtn'); s.style.display='flex';}")
        await pg.wait_for_timeout(300)
        st = await pg.evaluate("""()=>{const s=document.getElementById('stopBtn').parentElement;
            return {pad:parseFloat(getComputedStyle(document.getElementById('main')).paddingBottom),
                    want:s.offsetHeight+document.querySelector('.composer-wrap').offsetHeight};}""")
        chk("the stop button appearing is counted too", abs(st["pad"] - st["want"]) <= 1, st)
        await pg.evaluate("()=>{document.getElementById('stopBtn').style.display='';}")
        await pg.evaluate("()=>{const a=document.getElementById('agentBar'); document.getElementById('agentBarName').textContent='Travel planner'; a.hidden=false;}")
        await pg.wait_for_timeout(300)
        ag = await pg.evaluate("""()=>{const a=document.getElementById('agentBar');
            return {pad:parseFloat(getComputedStyle(document.getElementById('main')).paddingTop), want:a.offsetTop+a.offsetHeight};}""")
        chk("an agent bar opening is counted in the top padding", abs(ag["pad"] - ag["want"]) <= 1, ag)
        await save(pg, "glass-iphone-agent.png")
        await pg.evaluate("()=>{document.getElementById('agentBar').hidden=true;}")

        # ============ 4. dark: glass over true black ============
        await pg.evaluate("()=>applyThemeChoice('dark')")
        await pg.wait_for_timeout(350)
        dk = await pg.evaluate("()=>{const c=getComputedStyle(document.getElementById('pill'));return {bg:c.backgroundColor, page:getComputedStyle(document.body).backgroundColor};}")
        chk("dark theme: the page stays pure black", dk["page"] == "rgb(0, 0, 0)", dk)
        chk("dark theme: the glass is a dark tint, not a white sheet", dk["bg"].startswith("rgba(44, 44, 46"), dk)
        await pg.evaluate("()=>{const m=document.getElementById('main'); m.scrollTop=m.scrollHeight-m.clientHeight-260;}")
        await pg.wait_for_timeout(200)
        await save(pg, "glass-iphone-dark-midscroll.png")
        await pg.evaluate("()=>{document.getElementById('plusBtn').click();}")
        await pg.wait_for_timeout(300)
        pm = await pg.evaluate("()=>{const c=getComputedStyle(document.getElementById('plusMenu'));return {blur:c.backdropFilter||c.webkitBackdropFilter, r:c.borderTopLeftRadius, shown:c.display};}")
        chk("the + menu is glass too", "blur(" in (pm["blur"] or "") and pm["shown"] != "none", pm)
        # whatever else floats there (the jump-to-latest arrow) stays UNDER the open menu
        await pg.evaluate("()=>document.querySelector('.to-bottom').classList.add('show')")
        top_hit = await pg.evaluate("""()=>{const a=document.querySelector('.to-bottom').getBoundingClientRect(),
            m=document.getElementById('plusMenu').getBoundingClientRect();
            const x=a.left+a.width/2, y=a.top+a.height/2;
            if(x<m.left||x>m.right||y<m.top||y>m.bottom) return 'no-overlap';
            return document.elementFromPoint(x,y).closest('#plusMenu')?'menu':'arrow';}""")
        chk("the open + menu covers the jump-to-latest arrow, not the other way round", top_hit in ("menu", "no-overlap"), top_hit)
        await save(pg, "glass-iphone-dark-plusmenu.png")
        await pg.evaluate("()=>{document.getElementById('plusBtn').click(); applyThemeChoice('light');}")
        await pg.evaluate("()=>{document.getElementById('menuBtn').click();}")
        await pg.wait_for_timeout(450)
        sb = await pg.evaluate("()=>{const c=getComputedStyle(document.getElementById('sidebar'));return c.backdropFilter||c.webkitBackdropFilter;}")
        chk("the chats sidebar is glass", "blur(" in (sb or ""), sb)
        await save(pg, "glass-iphone-sidebar.png")
        await pg.keyboard.press("Escape")
        await pg.evaluate("()=>{try{closeSidebar()}catch(e){document.getElementById('sidebar').classList.remove('open')}}")

        # ============ 5. turning it off, by hand ============
        await pg.evaluate("()=>{document.getElementById('input').value='turn off the glass design'; sendMessage();}")
        await pg.wait_for_timeout(900)
        g = await pg.evaluate(GEOM)
        chk("saying 'turn off the glass design' turns it off", not g["glass"], g["glass"])
        chk("...and the chat goes back to sitting between the bars", g["mainTop"] >= g["topBottom"] - 1 and g["mainBottom"] <= g["wrapTop"] + 1, g)
        await pg.reload(wait_until="domcontentloaded")
        await pg.wait_for_timeout(1200)
        chk("...and it stays off after a reload", not await pg.evaluate("()=>document.documentElement.classList.contains('liquid-glass')"))
        await pg.evaluate("()=>{document.getElementById('input').value='liquid glass on'; sendMessage();}")
        await pg.wait_for_timeout(900)
        chk("'liquid glass on' brings it back", await pg.evaluate("()=>document.documentElement.classList.contains('liquid-glass')"))
        g = await pg.evaluate(GEOM)
        chk("...with the layout reinstalled", abs(g["padTop"] - g["topH"]) <= 1 and abs(g["mainTop"]) <= 1, g)
        await pg.evaluate("()=>{openSettingsPage(); renderSettings('general');}")
        await pg.wait_for_timeout(300)
        row = await pg.evaluate("()=>{const b=document.getElementById('setGlass'); return b?b.textContent:null;}")
        chk("Settings > General has a Glass design switch", row == "Turn off", row)
        await pg.evaluate("()=>document.getElementById('setGlass').click()")
        chk("...that works", not await pg.evaluate("()=>document.documentElement.classList.contains('liquid-glass')"))
        chk("iPhone run: no page errors", not errs, errs)
        await ctx.close()

        # ============ 6. the URL switch, and going back to automatic ============
        ctx, pg, errs = await page(b, WINDOWS, 1280, 800, query="?glass=1")
        chk("?glass=1 previews it on a laptop", await pg.evaluate("()=>document.documentElement.classList.contains('liquid-glass')"))
        await pg.evaluate(FILL)
        await pg.wait_for_timeout(400)
        await pg.evaluate("()=>{const m=document.getElementById('main'); m.style.scrollBehavior='auto'; m.scrollTop=m.scrollHeight-m.clientHeight-200;}")
        await pg.wait_for_timeout(200)
        await save(pg, "glass-laptop-preview.png")
        await pg.goto(URL + "?glass=auto", wait_until="domcontentloaded")
        await pg.wait_for_timeout(900)
        chk("?glass=auto puts the laptop back to normal", not await pg.evaluate("()=>document.documentElement.classList.contains('liquid-glass')"))
        chk("laptop run: no page errors", not errs, errs)
        await ctx.close()
        ctx, pg, errs = await page(b, IPHONE, query="?glass=0")
        chk("?glass=0 turns it off on an iPhone", not await pg.evaluate("()=>document.documentElement.classList.contains('liquid-glass')"))
        await ctx.close()

        # ============ 7. nobody else changed by a pixel ============
        if OLD_HTML is None:
            chk("previous build available for the pixel comparison", False, "git show HEAD:index.html failed")
        else:
            for label, init, vw, vh in [("Android phone", ANDROID, 390, 844), ("Windows laptop", WINDOWS, 1280, 800)]:
                imgs = []
                for old in (True, False):
                    ctx, pg, errs = await page(b, init, vw, vh, old=old)
                    await pg.add_style_tag(content="*{animation:none!important;transition:none!important;caret-color:transparent!important}")
                    await pg.evaluate(FILL)
                    await pg.wait_for_timeout(500)
                    await pg.evaluate("()=>{const m=document.getElementById('main'); m.style.scrollBehavior='auto'; m.scrollTop=m.scrollHeight;}")
                    await pg.wait_for_timeout(300)
                    imgs.append(await shot_b64(pg))
                    await ctx.close()
                ctx, pg, errs = await page(b, init, vw, vh)
                d = await pg.evaluate(DIFF, imgs + [68 if vw >= 900 else 0])
                await ctx.close()
                chk(label + ": the chat looks exactly as before, pixel for pixel", d["diff"] == 0, d)

        await b.close()
    for n in P: print("  PASS", n)
    for n in F: print("  FAIL", n)
    print("\n%d passed, %d failed" % (len(P), len(F)))
    sys.exit(1 if F else 0)

asyncio.run(main())
