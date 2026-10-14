/* ==========================================================================
   Pixel Pro · device module  ->  window.PixelDevice
   A scroll-scrubbed phone showcase. Everything is a pure function of the
   section's scroll progress p in [0,1] (lightly smoothed), so it plays
   forwards and backwards like scrubbing a video. No timers, no own rAF loop:
   the page calls PixelDevice.update(innerHeight) once per frame.

   PixelDevice.init(sectionEl)   wire up a <section class="pp-device-section">
   PixelDevice.update(vh)        per-frame; cheap, only writes changed values
   PixelDevice.resize()          recompute layout (also auto-detected in update)
   PixelDevice.onStage(fn)       fn(stage) on change: home|typing|thinking|answer|callouts
   ========================================================================== */
(function () {
  'use strict';

  var W = 420, H = 874;            // phone design size (CSS px, unscaled)
  var SX = 15, SY = 15;            // screen offset inside the phone face
  var DEG = Math.PI / 180;
  var QUESTION = 'What rocket is this?';
  var STAGES = [['home', 0], ['typing', 0.16], ['thinking', 0.36], ['answer', 0.46], ['callouts', 0.74]];
  var CALLOUT_ORDER = ['photo', 'sources', 'ticker'];

  var sec = null, els = {}, words = [], listeners = [];
  var RM = false, ready = false;
  var p = 0, target = 0, lastT = 0, wasVisible = false, idle = null;
  var stage = '';
  var L = null;                    // layout (from resize)
  var anchors = null;              // local positions of callout targets (lazy)

  /* ---------------- small helpers ---------------- */
  function clamp(v, a, b) { a = a === undefined ? 0 : a; b = b === undefined ? 1 : b; return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ramp(a, b, v) { return clamp((v - a) / (b - a)); }
  function smooth(a, b, v) { var t = ramp(a, b, v); return t * t * (3 - 2 * t); }
  function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function q(sel, root) { return (root || sec).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || sec).querySelectorAll(sel)); }

  // write-if-changed: style property, CSS variable, class, text, attribute
  function css(el, prop, val) {
    if (!el) return;
    var c = el.__ppS || (el.__ppS = {});
    if (c[prop] === val) return;
    c[prop] = val;
    if (prop.charAt(0) === '-') el.style.setProperty(prop, val); else el.style[prop] = val;
  }
  function cls(el, name, on) {
    if (!el) return;
    var c = el.__ppC || (el.__ppC = {});
    on = !!on;
    if (c[name] === on) return;
    c[name] = on;
    if (on) el.classList.add(name); else el.classList.remove(name);
  }
  function txt(el, s) { if (el && el.__ppT !== s) { el.__ppT = s; el.textContent = s; } }
  function attr(el, name, val) {
    if (!el) return;
    var c = el.__ppA || (el.__ppA = {});
    if (c[name] === val) return;
    c[name] = val; el.setAttribute(name, val);
  }

  /* ---------------- init ---------------- */
  function init(sectionEl) {
    if (ready) return api;
    watchShots();
    sec = sectionEl || document.querySelector('.pp-device-section');
    if (!sec || !sec.querySelector) { sec = null; return api; }
    try {
      RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        var onMq = function () { RM = mq.matches; resize(); };
        if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
      }
    } catch (e) { RM = false; }

    els.stage = q('.pp-stage');
    els.intro = q('.pp-intro');
    els.scene = q('.pp-scene');
    els.phone = q('.pp-phone');
    els.floor = q('.pp-floor');
    els.glow = q('.pp-glow');
    els.glowA = q('.pp-glow--amber');
    els.screen = q('.pp-screen');
    els.sleep = q('.pp-sleep');
    els.glass = q('.pp-glass');
    els.slices = qa('.pp-slice');
    els.hero = q('.pp-hero');
    els.ticker = q('.pp-ticker');
    els.liveDot = q('.pp-live i');
    els.userMsg = q('.pp-q');
    els.userImg = q('.pp-q img');
    els.thinkRow = q('.pp-thinking-row');
    els.thinkLbl = q('.pp-think-lbl');
    els.answer = q('.pp-answer');
    els.answerText = q('.pp-answer-text');
    els.sources = q('.pp-answer .pp-sources');
    els.srcLbl = q('.pp-answer .pp-src-lbl');
    els.srcItems = qa('.pp-answer .pp-src-a');
    els.composer = q('.pp-composer');
    els.attachment = q('.pp-attachment');
    els.attachIn = q('.pp-attachment-in');
    els.thumb = q('.pp-thumb');
    els.typed = q('.pp-typed');
    els.send = q('.pp-send');
    els.leaders = qa('.pp-ld');
    els.callouts = qa('.pp-callout');
    els.caption = q('.pp-caption');
    els.caps = qa('.pp-cap');
    if (!els.stage || !els.phone || !els.screen) { sec = null; return api; }

    splitWords();
    ready = true;
    sec.classList.add('pp-ready');
    resize();
    target = p = progressNow().p;
    render(p, true);

    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { if (ready) { resize(); render(p, true); } });
    }
    return api;
  }

  // turn the answer paragraph into word spans (keeps <strong> and spacing)
  function splitWords() {
    var root = els.answerText;
    if (!root) return;
    words = [];
    (function walk(node) {
      var kids = Array.prototype.slice.call(node.childNodes);
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType === 3) {
          var parts = k.nodeValue.split(/(\s+)/), frag = document.createDocumentFragment(), last = null;
          for (var j = 0; j < parts.length; j++) {
            var s = parts[j];
            if (!s) continue;
            if (/^\s+$/.test(s)) {
              if (last) last.textContent += ' '; else frag.appendChild(document.createTextNode(' '));
            } else {
              last = document.createElement('span');
              last.className = 'pp-w';
              last.textContent = s;
              frag.appendChild(last);
              words.push(last);
            }
          }
          node.replaceChild(frag, k);
        } else if (k.nodeType === 1) {
          walk(k);
        }
      }
    })(root);
  }

  /* ---------------- layout ---------------- */
  function resize() {
    if (!sec) return;
    var vw = els.stage.clientWidth || window.innerWidth || 1024;
    var sh = els.stage.clientHeight || window.innerHeight || 768;
    var land = vw > sh && sh < 520;           // phone held sideways: fit below the nav, caption beside
    var narrow = vw < 760 && !land;
    var s, cy, riseY, finalX = 0, finalRY, finalRX, finalS, capMode, capX, capY, capW;
    var NAV = 72;

    if (narrow) {
      // reserve room under the phone for the tallest caption at this width
      capW = Math.min(520, vw - 32);
      cls(els.caption, 'pp-below', true);
      css(els.caption, '--pp-cap-w', Math.round(capW) + 'px');
      var capH = els.caption.offsetHeight || 0;
      var capSpace = Math.max(118, Math.min(sh * 0.3, capH + 18 + 14));
      s = Math.min((sh - NAV - capSpace - 8) / H, (vw * 0.74) / W);
      cy = (NAV + (sh - capSpace)) / 2 - sh / 2;
      finalRY = -12; finalRX = 3; finalS = 0.98;
    } else if (land) {
      s = Math.min((sh - NAV - 12) / H, (vw * 0.34) / W);
      cy = NAV / 2 - 6 / 2;
      finalRY = -12; finalRX = 3; finalS = 1;
    } else {
      s = Math.min((sh * 0.78) / H, (sh - NAV - 16) / H, (vw * 0.4) / W, 1.35);
      cy = Math.min(14, sh * 0.02);
      finalRY = -16; finalRX = 3; finalS = 0.97;
    }
    s = Math.max(0.2, s);
    riseY = sh * 0.62;

    var pw = W * s, ph = H * s;
    // never let the top of the phone slide under the fixed nav
    if (!narrow) cy = Math.max(cy, NAV + 8 - sh / 2 + ph / 2);
    var phoneLeftCentered = vw / 2 - pw / 2;
    var useCallouts = false;
    if (!narrow && !land) {
      // move the phone right for the callouts if there is room on the left
      var shift = RM ? 0 : Math.max(0, Math.min(vw * 0.17, pw * 0.62 + 40, vw / 2 - 36 - pw / 2));
      var leftRoom = (vw / 2 + shift) - pw * 0.5 - 60 - 24;
      if (leftRoom >= 210) { useCallouts = true; finalX = shift; }
    }
    // caption beside the phone if there is room, else under it
    if (land && phoneLeftCentered - 40 >= 160) {
      capMode = 'side';
      capW = Math.min(320, phoneLeftCentered - 40);
      capX = phoneLeftCentered - 24 - capW;
      capY = sh / 2 + cy;
    } else if (!narrow && !land && phoneLeftCentered - 64 - 32 >= 230) {
      capMode = 'side';
      capW = Math.min(380, phoneLeftCentered - 64 - Math.max(32, vw * 0.05));
      capX = phoneLeftCentered - 64 - capW;
      capY = sh / 2 + cy;
    } else {
      capMode = 'below';
      capW = Math.min(520, vw - 32);
      capX = (vw - capW) / 2;
      capY = sh / 2 + cy + ph / 2 + (narrow ? 18 : 28);
    }

    L = {
      vw: vw, sh: sh, narrow: narrow, s: s, cy: cy, riseY: riseY,
      finalX: finalX, finalRY: finalRY, finalRX: finalRX, finalS: finalS,
      useCallouts: useCallouts, capMode: capMode,
      d: Math.max(1400, ph * 3.4)
    };

    cls(sec, 'pp-narrow', narrow || !useCallouts);
    css(els.scene, 'perspective', Math.round(L.d) + 'px');
    cls(els.caption, 'pp-below', capMode === 'below');
    css(els.caption, '--pp-cap-x', Math.round(capX) + 'px');
    css(els.caption, '--pp-cap-y', Math.round(capY) + 'px');
    css(els.caption, '--pp-cap-w', Math.round(capW) + 'px');

    // callout box metrics (used to stack them without overlap)
    if (useCallouts) {
      var cw = Math.min(330, Math.max(200, (vw / 2 + finalX) - pw * 0.5 - 60 - Math.max(24, vw * 0.04)));
      L.cw = cw;
      for (var i = 0; i < els.callouts.length; i++) css(els.callouts[i], '--pp-cw', Math.round(cw) + 'px');
      L.cHeights = els.callouts.map(function (c) { return c.offsetHeight || 80; });
      L.cAnchor = els.callouts.map(function (c) {
        var b = c.querySelector('b');
        var lh = b ? parseFloat(window.getComputedStyle(b).lineHeight) : 24;
        return (isNaN(lh) ? 24 : lh) / 2;
      });
    }
    anchors = null;                  // re-measure lazily
    els.__inH = 0;
  }

  // measure where the callout targets sit inside the (unscaled) phone face
  function measureAnchors() {
    function pos(el, fx, fy) {
      var x = 0, y = 0, n = el, w = el.offsetWidth, h = el.offsetHeight;
      while (n && n !== els.screen) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
      if (n !== els.screen) return null;
      return { x: SX + x + w * fx - W / 2, y: SY + y + h * fy - H / 2 };
    }
    var a = {};
    a.ticker = els.liveDot ? pos(els.liveDot, 0.5, 0.5) : null;
    a.photo = els.userImg ? pos(els.userImg, 0.3, 0.45) : null;
    a.sources = els.srcLbl ? pos(els.srcLbl, 0, 0.5) : null;
    if (a.sources) a.sources.x -= 6;
    return a;
  }

  /* ---------------- progress ---------------- */
  function progressNow() {
    var r = sec.getBoundingClientRect();
    var dist = r.height - (L ? L.sh : window.innerHeight);
    return { p: clamp(-r.top / Math.max(1, dist)), top: r.top, bottom: r.bottom };
  }

  function update(vh) {
    if (!ready || !sec) return;
    vh = vh || window.innerHeight;
    var vw = window.innerWidth;
    if (!els.stage.clientHeight) return;      // section hidden (display:none)
    if (L && (vw !== L.lastVW || els.stage.clientHeight !== L.sh)) { resize(); }
    if (L) L.lastVW = vw;

    var pr = progressNow();
    var visible = pr.bottom > -40 && pr.top < vh + 40;
    if (idle !== !visible) { idle = !visible; cls(sec, 'pp-idle', idle); }
    target = pr.p;
    if (!visible) { p = target; wasVisible = false; return; }

    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var dt = lastT ? Math.min(100, now - lastT) : 16.7;
    lastT = now;
    if (RM || !wasVisible) p = target;
    else {
      var k = 1 - Math.pow(1 - 0.16, dt / 16.7);
      p += (target - p) * k;
      if (Math.abs(target - p) < 0.0005) p = target;
    }
    wasVisible = true;
    render(p, false);
  }

  /* ---------------- rendering ---------------- */
  function stageAt(v) {
    var name = STAGES[0][0];
    for (var i = 0; i < STAGES.length; i++) if (v >= STAGES[i][1]) name = STAGES[i][0];
    return name;
  }

  function pose(v) {
    var rise = smooth(0, 0.16, v);
    var fin = easeInOutCubic(ramp(0.74, 0.87, v));
    var o = {};
    if (RM) {
      // reduced motion: no travel or rotation, the title and the phone simply cross-fade
      o.tx = L.finalX * smooth(0.74, 0.8, v); o.ty = L.cy; o.rx = 0; o.ry = 0; o.rz = 0; o.s = L.s;
      o.fade = smooth(0.1, 0.16, v);
    } else {
      o.tx = L.finalX * fin;
      o.ty = L.cy + L.riseY * (1 - rise) - (L.narrow ? 0 : 6 * fin);
      o.rx = 52 * (1 - rise) + L.finalRX * fin;
      o.ry = L.finalRY * fin;
      o.rz = -7 * (1 - rise);
      o.s = L.s * lerp(0.85, 1, rise) * lerp(1, L.finalS, fin);
      o.fade = 1;
    }
    o.rise = rise; o.fin = fin;
    return o;
  }

  function project(P, lx, ly) {
    var x = lx * P.s, y = ly * P.s, z = 0, c, n;
    c = Math.cos(P.rz * DEG); n = Math.sin(P.rz * DEG);
    var x1 = x * c - y * n, y1 = x * n + y * c, z1 = z;
    c = Math.cos(P.ry * DEG); n = Math.sin(P.ry * DEG);
    var x2 = x1 * c + z1 * n, y2 = y1, z2 = -x1 * n + z1 * c;
    c = Math.cos(P.rx * DEG); n = Math.sin(P.rx * DEG);
    var x3 = x2, y3 = y2 * c - z2 * n, z3 = y2 * n + z2 * c;
    var k = L.d / (L.d - z3);
    return { x: L.vw / 2 + (x3 + P.tx) * k, y: L.sh / 2 + (y3 + P.ty) * k };
  }

  function render(v, force) {
    if (!L) return;
    var P = pose(v);

    // --- phone ---
    var tf = 'translate3d(' + r1(P.tx) + 'px,' + r1(P.ty) + 'px,0)';
    if (Math.abs(P.rx) > 0.01 || Math.abs(P.ry) > 0.01 || Math.abs(P.rz) > 0.01) {
      tf += ' rotateX(' + r2(P.rx) + 'deg) rotateY(' + r2(P.ry) + 'deg) rotateZ(' + r2(P.rz) + 'deg)';
    }
    tf += ' scale(' + (Math.round(P.s * 10000) / 10000) + ')';
    css(els.phone, 'transform', tf);
    css(els.scene, 'opacity', String(r2(P.fade)));
    // the edge slices only matter while the phone is turned; hide them when it faces us
    var turned = !RM && (v < 0.17 || v > 0.745);
    for (var i = 0; i < els.slices.length; i++) css(els.slices[i], 'visibility', turned || i === els.slices.length - 1 ? 'visible' : 'hidden');
    css(els.glass, '--pp-gx', Math.round(-P.ry * 9 + P.rx * 4 + v * 60) + 'px');
    css(els.sleep, 'opacity', String(r2(1 - smooth(0.0, 0.075, v))));

    // floor shadow + light
    var bottomY = P.ty + (H * P.s) / 2;
    css(els.floor, 'transform', 'translate3d(' + r1(P.tx) + 'px,' + r1(bottomY + 30 * P.s) + 'px,0) scale(' + r2(P.s * 1.02) + ',' + r2(P.s * (1 - P.fin * 0.25)) + ')');
    css(els.floor, 'opacity', String(r2(P.rise * (1 - P.fin * 0.35) * 0.9)));
    css(els.glow, 'transform', 'translate3d(' + r1(P.tx * 0.8) + 'px,' + r1(P.ty * 0.7) + 'px,0)');
    css(els.glow, 'opacity', String(r2(0.35 + 0.5 * P.rise + 0.15 * smooth(0.46, 0.7, v))));
    css(els.glowA, 'transform', 'translate3d(' + r1(P.tx + 120 * L.s) + 'px,' + r1(P.ty + 160 * L.s) + 'px,0)');
    css(els.glowA, 'opacity', String(r2(0.3 + 0.5 * smooth(0.36, 0.7, v) + 0.2 * P.fin)));

    // --- intro title ---
    var io = 1 - (RM ? smooth(0.04, 0.1, v) : smooth(0.03, 0.092, v));
    css(els.intro, 'opacity', String(r2(io)));
    css(els.intro, 'transform', RM ? 'none' : 'translate3d(0,' + r1(-90 * smooth(0, 0.12, v)) + 'px,0)');
    css(els.intro, 'visibility', io <= 0.001 ? 'hidden' : 'visible');

    // --- app screen ---
    renderScreen(v, force);

    // --- stage + caption + callouts ---
    var st = stageAt(v);
    if (st !== stage) {
      stage = st;
      if (sec) sec.setAttribute('data-pp-stage', st);
      for (var j = 0; j < listeners.length; j++) { try { listeners[j](st); } catch (e) { /* ignore */ } }
    }
    var capIdx = -1;
    if (v > 0.175) {
      if (st === 'typing' || st === 'thinking') capIdx = 0;
      else if (st === 'answer') capIdx = 1;
      else if (st === 'callouts') capIdx = L.useCallouts ? -1 : 2;
    }
    for (var c = 0; c < els.caps.length; c++) cls(els.caps[c], 'pp-on', c === capIdx);
    cls(els.ticker, 'pp-hl', !L.useCallouts && st === 'callouts' && v > 0.8);

    renderCallouts(v, P);
  }

  function renderScreen(v) {
    // composer: attach a photo, type the question, send
    var att = (v >= 0.16 && v < 0.36) ? easeOutQuad(ramp(0.165, 0.205, v)) : 0;
    var inH = els.attachIn ? (els.attachIn.offsetHeight || 72) : 72;
    if (!els.__inH) els.__inH = inH;
    css(els.attachment, 'height', Math.round(els.__inH * att) + 'px');
    css(els.thumb, 'transform', 'scale(' + r2(0.6 + 0.4 * att) + ')');
    css(els.thumb, 'opacity', String(r2(att)));
    var n = (v >= 0.16 && v < 0.36) ? Math.round(ramp(0.215, 0.335, v) * QUESTION.length) : 0;
    txt(els.typed, QUESTION.slice(0, n));
    cls(els.composer, 'pp-has-text', n > 0);
    cls(els.composer, 'pp-focus', v >= 0.165 && v < 0.355);
    cls(els.send, 'pp-press', v >= 0.348 && v < 0.362);
    cls(els.send, 'pp-busy', v >= 0.362 && v < 0.705);

    // home hero slides away, the question bubble arrives
    var h = smooth(0.352, 0.372, v);
    css(els.hero, 'opacity', String(r2(1 - h)));
    css(els.hero, 'transform', h > 0 ? 'translate3d(0,' + r1(-70 * h) + 'px,0) scale(' + r2(1 - 0.06 * h) + ')' : 'none');
    css(els.hero, 'visibility', h >= 0.999 ? 'hidden' : 'visible');
    var u = easeOutQuad(ramp(0.368, 0.394, v));
    css(els.userMsg, 'opacity', String(r2(u)));
    css(els.userMsg, 'transform', u < 1 ? 'translate3d(0,' + r1(22 * (1 - u)) + 'px,0) scale(' + r2(0.94 + 0.06 * u) + ')' : 'none');

    // thinking (pixel wave), then the streamed answer
    var showThink = v >= 0.392 && v < 0.46;
    css(els.thinkRow, 'display', showThink ? 'flex' : 'none');
    if (showThink) {
      var t = easeOutQuad(ramp(0.392, 0.41, v));
      css(els.thinkRow, 'opacity', String(r2(t)));
      css(els.thinkRow, 'transform', 'translate3d(0,' + r1(10 * (1 - t)) + 'px,0)');
      txt(els.thinkLbl, v < 0.418 ? 'Thinking…' : 'Thinking & searching the web…');
    }
    var showAns = v >= 0.46;
    css(els.answer, 'display', showAns ? 'flex' : 'none');
    var nw = showAns ? Math.max(1, Math.ceil(ramp(0.462, 0.655, v) * words.length)) : 0;
    if (els.__nw !== nw) {
      for (var i = 0; i < words.length; i++) cls(words[i], 'pp-on', i < nw);
      els.__nw = nw;
    }
    var sv = ramp(0.664, 0.7, v);
    css(els.sources, 'display', showAns && sv > 0 ? 'flex' : 'none');
    for (var k = 0; k < els.srcItems.length; k++) {
      var si = easeOutQuad(ramp(0.674 + k * 0.012, 0.69 + k * 0.012, v));
      css(els.srcItems[k], 'opacity', String(r2(si)));
      css(els.srcItems[k], 'transform', si < 1 ? 'translate3d(0,' + r1(6 * (1 - si)) + 'px,0)' : 'none');
    }
    if (els.sources) css(els.sources, 'opacity', String(r2(easeOutQuad(sv))));
  }

  function renderCallouts(v, P) {
    var on = L.useCallouts && v > 0.765;
    if (!L.useCallouts) {
      for (var z = 0; z < els.callouts.length; z++) { css(els.callouts[z], 'opacity', '0'); }
      for (var y = 0; y < els.leaders.length; y++) css(els.leaders[y], 'opacity', '0');
      return;
    }
    if (!on) {
      for (var a = 0; a < els.callouts.length; a++) { css(els.callouts[a], 'opacity', '0'); css(els.callouts[a], 'visibility', 'hidden'); }
      for (var b = 0; b < els.leaders.length; b++) css(els.leaders[b], 'opacity', '0');
      return;
    }
    if (!anchors) anchors = measureAnchors();

    // phone's left edge (projected), callouts sit to its left
    var tl = project(P, -W / 2, -H / 2), bl = project(P, -W / 2, H / 2);
    var edge = Math.min(tl.x, bl.x);
    var xr = edge - 60;
    var items = [];
    for (var i = 0; i < els.callouts.length; i++) {
      var key = els.callouts[i].getAttribute('data-target');
      var an = anchors[key];
      if (!an) continue;
      var pt = project(P, an.x, an.y);
      items.push({ i: i, pt: pt, h: L.cHeights[i], a: L.cAnchor[i] });
    }
    items.sort(function (m, n) { return m.pt.y - n.pt.y; });
    var prevBottom = 70;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var top = Math.max(it.pt.y - it.a, prevBottom + 22);
      top = Math.min(top, L.sh - it.h - 20);
      it.top = top; prevBottom = top + it.h;
    }
    for (var m = 0; m < items.length; m++) {
      var o = items[m], idx = o.i;
      var order = CALLOUT_ORDER.indexOf(els.callouts[idx].getAttribute('data-target'));
      if (order < 0) order = idx;
      var a0 = 0.78 + order * 0.04;
      var show = easeOutQuad(ramp(a0, a0 + 0.05, v));
      var draw = easeInOutCubic(ramp(a0 - 0.01, a0 + 0.045, v));
      var el = els.callouts[idx];
      css(el, 'visibility', show > 0 ? 'visible' : 'hidden');
      css(el, 'opacity', String(r2(show)));
      css(el, 'transform', 'translate3d(' + r1(xr - L.cw - 16 * (1 - show)) + 'px,' + r1(o.top) + 'px,0)');

      var ld = els.leaders[idx];
      if (!ld) continue;
      var y0 = o.top + o.a, x0 = xr + 16, xb = edge - 14;
      var x1 = o.pt.x, y1 = o.pt.y;
      var seg1 = Math.max(0, xb - x0), seg2 = Math.sqrt((x1 - xb) * (x1 - xb) + (y1 - y0) * (y1 - y0));
      var len = seg1 + seg2;
      var path = ld.firstElementChild || ld.querySelector('path');
      attr(path, 'd', 'M' + r1(x0) + ' ' + r1(y0) + 'H' + r1(xb) + 'L' + r1(x1) + ' ' + r1(y1));
      css(path, 'stroke-dasharray', r1(len) + ' ' + r1(len + 2));
      css(path, 'stroke-dashoffset', String(r1(len * (1 - draw))));
      var dots = ld.querySelectorAll('circle');
      for (var d = 0; d < dots.length; d++) { attr(dots[d], 'cx', String(r1(x1))); attr(dots[d], 'cy', String(r1(y1))); }
      css(ld, 'opacity', String(r2(Math.min(1, draw * 1.6))));
      for (var e = 0; e < dots.length; e++) css(dots[e], 'opacity', String(r2(ramp(0.85, 1, draw))));
    }
  }

  /* pause the bento screenshots' loops while they are off screen */
  var shotsWatched = false;
  function watchShots() {
    if (shotsWatched || !('IntersectionObserver' in window)) return;
    shotsWatched = true;
    var shots = document.querySelectorAll('.pp-shot');
    if (!shots.length) return;
    try {
      var io = new IntersectionObserver(function (es) {
        for (var i = 0; i < es.length; i++) es[i].target.classList.toggle('pp-idle', !es[i].isIntersecting);
      }, { rootMargin: '120px 0px' });
      for (var i = 0; i < shots.length; i++) io.observe(shots[i]);
    } catch (e) { /* ignore */ }
  }

  function onStage(fn) { if (typeof fn === 'function') listeners.push(fn); return api; }

  var api = {
    init: init,
    update: update,
    resize: function () { if (ready) { resize(); render(p, true); } },
    onStage: onStage
  };
  try {
    Object.defineProperty(api, 'progress', { get: function () { return p; } });
    Object.defineProperty(api, 'stage', { get: function () { return stage; } });
  } catch (e) { /* ignore */ }
  window.PixelDevice = api;
})();
