/* Pixel Pro AI: hero 3D logo (window.PixelHero3D)
   A studio-lit render of the Pixel Pro cross: five rounded cubes in clearcoat physical materials,
   lit by a procedural softbox environment (PMREM), an amber core light, a cool rim light,
   a glossy-floor reflection and a periodic specular light sweep.
   Needs the global THREE (r128) loaded before this file. No modules, no network. */
(function (root) {
  'use strict';

  var EDGE = 1;            // cube edge
  var GAP = 0.2;           // gap between cubes
  var RADIUS = 0.18;       // bevel radius (18% of edge)
  var STEP = EDGE + GAP;   // centre to centre
  var LOGO_H = 3 * EDGE + 2 * GAP;
  var FLOOR_Y = -(1.5 * EDGE + GAP) - 0.42;
  var FOV = 28;
  var ELEV = 5.5 * Math.PI / 180;   // camera elevation
  var FILL = 0.5;                   // logo height / container height

  // slot order = arrival order: top, right, bottom, left, centre (amber last).
  // from: where the cube starts relative to its slot (it also starts deep in z), swirled by SWIRL on the way in.
  var SLOTS = [
    { key: 'top',    x: 0,     y: STEP,  kind: 'deep',  from: [0, 4.5],  rot: [2.4, -1.6, 0.9],  delay: 0.00, ex: [0, 1, 0.55],   er: [-0.55, 0, 0.12] },
    { key: 'right',  x: STEP,  y: 0,     kind: 'blue',  from: [5.5, 0],  rot: [-1.2, 2.6, -1.9], delay: 0.10, ex: [1, 0, -0.35],  er: [0, 0.6, -0.1] },
    { key: 'bottom', x: 0,     y: -STEP, kind: 'deep',  from: [0, -4.5], rot: [-2.2, 1.1, 2.2],  delay: 0.20, ex: [0, -1, 0.5],   er: [0.55, 0, -0.12] },
    { key: 'left',   x: -STEP, y: 0,     kind: 'blue',  from: [-5.5, 0], rot: [1.5, -2.4, 1.3],  delay: 0.30, ex: [-1, 0, -0.35], er: [0, -0.6, 0.1] },
    { key: 'centre', x: 0,     y: 0,     kind: 'spark', from: [0, 0.8],  rot: [1.7, 2.9, -0.6], delay: 0.86, ex: [0, 0, 0.75],   er: [0.25, -0.35, 0] }
  ];
  var SWIRL = 1.05;        // radians of spiral on the way in

  var S0 = 0.24;           // apparent scale at launch (how deep the cubes start)
  var INTRO_END = 3.8;     // springs have fully settled by now (the visible assembly is ~2.2 s)
  var SWEEP_FIRST = 2.3, SWEEP_PERIOD = 6.6, SWEEP_DUR = 1.55;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function damp(cur, target, lambda, dt) { return cur + (target - cur) * (1 - Math.exp(-lambda * dt)); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  // unit step response of a damped spring (0 -> 1 with overshoot when zeta < 1)
  function spring(t, w, z) {
    if (t <= 0) return 0;
    var wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  }

  function webglContext(canvas) {
    var attrs = { alpha: true, antialias: true, premultipliedAlpha: true, depth: true, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false };
    var names = ['webgl2', 'webgl', 'experimental-webgl'];
    for (var i = 0; i < names.length; i++) {
      try { var gl = canvas.getContext(names[i], attrs); if (gl) return gl; } catch (e) { /* try next */ }
    }
    return null;
  }

  function prefersReduced() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  // ---------- geometry: rounded cube (smooth normals, bevel zones subdivided) ----------
  function roundedCube(THREE, size, radius, seg) {
    var n = seg * 2 + 1;
    var geo = new THREE.BoxGeometry(1, 1, 1, n, n, n);
    var pos = geo.attributes.position;
    var nor = geo.attributes.normal;
    var h = size / 2, inner = h - radius;
    function map(u) {
      var k = Math.round((u + 0.5) * n);
      if (k <= seg) return -h + radius * (k / seg);
      return inner + radius * ((k - seg - 1) / seg);
    }
    for (var i = 0; i < pos.count; i++) {
      var x = map(pos.getX(i)), y = map(pos.getY(i)), z = map(pos.getZ(i));
      var cx = clamp(x, -inner, inner), cy = clamp(y, -inner, inner), cz = clamp(z, -inner, inner);
      var dx = x - cx, dy = y - cy, dz = z - cz;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= len; dy /= len; dz /= len;
      pos.setXYZ(i, cx + dx * radius, cy + dy * radius, cz + dz * radius);
      nor.setXYZ(i, dx, dy, dz);
    }
    pos.needsUpdate = true; nor.needsUpdate = true;
    geo.computeBoundingSphere();
    return geo;
  }

  // ---------- canvas textures (white alpha masks, dithered against banding) ----------
  function maskTexture(THREE, size, profile) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    if (!ctx) return null;
    var img = ctx.createImageData(size, size), d = img.data;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
        var r = Math.sqrt(dx * dx + dy * dy);
        var a = r >= 1 ? 0 : profile(r);
        var i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = clamp(Math.round(a * 255 + (Math.random() - 0.5) * 1.6), 0, 255);
        if (a <= 0) d[i + 3] = 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }
  function edgeFade(r) { var e = 1 - r * r; return e * e; }

  // ---------- environment: dark studio with softboxes -> PMREM ----------
  function buildEnvironment(THREE, renderer) {
    var env = new THREE.Scene();
    env.background = new THREE.Color(0x05060c);
    var geo = new THREE.PlaneGeometry(1, 1);
    var mats = [];
    function panel(w, h, x, y, z, r, g, b, lookY) {
      var m = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), side: THREE.DoubleSide });
      mats.push(m);
      var p = new THREE.Mesh(geo, m);
      p.scale.set(w, h, 1);
      p.position.set(x, y, z);
      p.lookAt(0, lookY || 0, 0);
      env.add(p);
      return p;
    }
    // big overhead softbox (slightly forward so top bevels catch it)
    panel(9, 6, 0, 7, 1.2, 2.2, 2.25, 2.4);
    // narrow strip lights left (warm-neutral) and right (cool): the crisp edge highlights
    panel(0.55, 10, -6.5, 0.5, 2.6, 6.0, 5.8, 5.5);
    panel(0.4, 10, 6.5, 0.5, -0.8, 4.2, 4.6, 5.8);
    // soft frontal gradient card above camera: a graded reflection across the front faces
    panel(12, 2.6, 0, 4.6, 8, 0.6, 0.62, 0.72, 2.0);
    // faint frontal fill below horizon, keeps the faces from going muddy black
    panel(12, 3, 0, -2.5, 8.5, 0.05, 0.055, 0.08);
    // brand-blue cyclorama behind: blue rim reflections on back-facing bevels
    panel(14, 6, 0, 1, -8, 0.025, 0.07, 0.75);
    // small warm kicker low right: amber glints on lower bevels
    panel(1.6, 1.6, 5.5, -2.6, 4.5, 2.4, 1.0, 0.16);
    // floor bounce
    var floor = panel(24, 24, 0, -4, 0, 0.03, 0.035, 0.06);
    floor.rotation.set(-Math.PI / 2, 0, 0);

    var pmrem = new THREE.PMREMGenerator(renderer);
    var rt = pmrem.fromScene(env, 0.025, 0.1, 60);
    pmrem.dispose();
    geo.dispose();
    for (var i = 0; i < mats.length; i++) mats[i].dispose();
    return rt;
  }

  // ---------- materials ----------
  var SWEEP_PARS = [
    'uniform float uSweepPos;', 'uniform float uSweepAmt;', 'uniform float uSweepWidth;',
    'uniform vec2 uSweepDir;', 'uniform vec3 uSweepOrigin;', 'uniform vec3 uSweepColor;',
    'uniform float uEdgeGlow;', 'uniform float uFloorY;', 'uniform float uReflAmt;', 'uniform float uReflFade;',
    'uniform vec3 uCoreView;', 'uniform float uCoreAmt;', 'uniform vec3 uCoreColor;',
    'varying vec3 vPhWorld;', 'varying float vPhRelY;', 'varying vec3 vPhLocal;'
  ].join('\n');

  // Linear albedos, pre-compensated for ACES so the lit faces land on the brand hexes
  // (#5672FF, #2E46E2, #FFB43A) instead of drifting pastel / yellow.
  var LIN = {
    blue:  [0.035, 0.14, 1.0],
    deep:  [0.008, 0.05, 0.8],
    spark: [0.42, 0.12, 0.004]
  };
  var EMISSIVE = [1.0, 0.24, 0.01];

  function cubeMaterial(THREE, kind, shared, reflect) {
    var spark = kind === 'spark';
    var col = new THREE.Color().setRGB(LIN[kind][0], LIN[kind][1], LIN[kind][2]);
    var m = new THREE.MeshPhysicalMaterial({
      color: col,
      roughness: spark ? 0.32 : (kind === 'deep' ? 0.2 : 0.22),
      metalness: spark ? 0.0 : 0.1,
      clearcoat: spark ? 0.55 : 1,
      clearcoatRoughness: spark ? 0.1 : 0.045,
      envMapIntensity: spark ? 0.3 : (kind === 'deep' ? 1.2 : 1.05)
    });
    if ('reflectivity' in m) m.reflectivity = 0.5;
    if (spark) {
      m.emissive = new THREE.Color().setRGB(EMISSIVE[0], EMISSIVE[1], EMISSIVE[2]);
      m.emissiveIntensity = 1.2;
    }
    if (reflect) { m.transparent = true; m.depthWrite = false; }
    var u = shared;
    m.onBeforeCompile = function (shader) {
      shader.uniforms.uSweepPos = u.uSweepPos;
      shader.uniforms.uSweepAmt = reflect ? u.zero : u.uSweepAmt;
      shader.uniforms.uSweepWidth = u.uSweepWidth;
      shader.uniforms.uSweepDir = u.uSweepDir;
      shader.uniforms.uSweepOrigin = u.uSweepOrigin;
      shader.uniforms.uSweepColor = u.uSweepColor;
      shader.uniforms.uEdgeGlow = u.uEdgeGlow;
      shader.uniforms.uFloorY = u.uFloorY;
      shader.uniforms.uReflAmt = u.uReflAmt;
      shader.uniforms.uReflFade = u.uReflFade;
      shader.uniforms.uCoreView = u.uCoreView;
      shader.uniforms.uCoreAmt = reflect ? u.zero : u.uCoreAmt;
      shader.uniforms.uCoreColor = u.uCoreColor;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vPhWorld;\nvarying float vPhRelY;\nvarying vec3 vPhLocal;')
        .replace('#include <project_vertex>', [
          '#include <project_vertex>',
          '\tvPhLocal = transformed;',
          '\tvPhWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
          '\tvPhRelY = vPhWorld.y - modelMatrix[ 3 ].y;'
        ].join('\n'));
      var fs = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + SWEEP_PARS);
      // body gradient: lit from the big overhead softbox, falling off toward the floor
      fs = fs.replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'float phGrad = smoothstep( -0.62, 0.62, vPhRelY );',
        'diffuseColor.rgb *= mix( ' + (spark ? '0.8, 1.1' : '0.5, 1.2') + ', phGrad );'
      ].join('\n'));
      if (spark) {
        // light from within: faces glow fully, the rounded edges glow hotter (thinner wall, more light leaks)
        fs = fs.replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          '{',
          '  float phNv = saturate( dot( normal, normalize( vViewPosition ) ) );',
          '  float phR = length( vPhLocal );',
          '  float phCore = 1.0 - smoothstep( 0.5, 0.74, phR );',
          '  totalEmissiveRadiance *= mix( 0.7, 1.1, phCore ) * mix( uEdgeGlow, 1.0, smoothstep( 0.15, 0.9, phNv ) ) * mix( 0.88, 1.08, phGrad );',
          '  totalEmissiveRadiance += emissive.r * vec3( 1.0, 0.5, 0.12 ) * ( 0.2 * phCore * phCore * phNv );',
          '}'
        ].join('\n'));
      }
      var tail = reflect ? [
        'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
        '{',
        '  float phDepth = uFloorY - vPhWorld.y;',
        '  gl_FragColor.a *= uReflAmt * ( 1.0 - smoothstep( 0.0, uReflFade, phDepth ) ) * step( 0.0, phDepth );',
        '}'
      ] : [
        '{',
        // the glowing core mirrored in the glossy neighbours: faces that look at it carry its reflection
        '  vec3 phToC = uCoreView + vViewPosition;',
        '  float phDC = max( length( phToC ), 1e-3 );',
        '  vec3 phL = phToC / phDC;',
        '  vec3 phV = normalize( vViewPosition );',
        '  vec3 phR = reflect( -phV, normal );',
        '  float phCosA = dot( phR, phL );',
        '  float phRad = atan( 0.6 / phDC );',
        '  float phLobe = smoothstep( cos( phRad * 1.3 ), cos( phRad * 0.7 ), phCosA ) + 0.3 * pow( saturate( phCosA ), 20.0 );',
        '  float phF = 0.22 + 0.78 * pow( 1.0 - saturate( dot( normal, phV ) ), 3.0 );',
        '  float phW = min( phLobe * phF * step( 0.0, dot( normal, phL ) ), 0.5 ) * saturate( uCoreAmt );',
        '  outgoingLight = outgoingLight * ( 1.0 - 0.85 * phW ) + uCoreColor * ( uCoreAmt * phW );',
        '  float phS = dot( vPhWorld.xy - uSweepOrigin.xy, uSweepDir );',
        '  float phD = ( phS - uSweepPos ) / uSweepWidth;',
        '  float phD2 = ( phS - uSweepPos + uSweepWidth * 2.2 ) / ( uSweepWidth * 0.22 );',
        '  float phBand = exp( -phD * phD * phD * phD ) + 0.6 * exp( -phD2 * phD2 );',
        '  float phNv = saturate( dot( normal, geometry.viewDir ) );',
        '  float phFres = pow( 1.0 - phNv, 2.0 );',
        '  outgoingLight += uSweepColor * ( uSweepAmt * phBand * ( 0.1 + 1.2 * phFres ) );',
        '}',
        'gl_FragColor = vec4( outgoingLight, diffuseColor.a );'
      ];
      fs = fs.replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', tail.join('\n'));
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = function () { return 'ph3d-' + (spark ? 'spark' : 'body') + (reflect ? '-r' : ''); };
    return m;
  }

  function glowMaterial(THREE, tex, hex, opacity, additive) {
    var c = new THREE.Color(hex);
    if (c.convertSRGBToLinear) c.convertSRGBToLinear();
    return new THREE.SpriteMaterial({
      map: tex, color: c, opacity: opacity, transparent: true, depthWrite: false,
      blending: additive === false ? THREE.NormalBlending : THREE.AdditiveBlending, toneMapped: false
    });
  }

  function planeMaterial(THREE, tex, hex, opacity, additive) {
    var c = new THREE.Color(hex);
    if (c.convertSRGBToLinear) c.convertSRGBToLinear();
    return new THREE.MeshBasicMaterial({
      map: tex, color: c, opacity: opacity, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false
    });
  }

  // =====================================================================
  function mount(containerEl, opts) {
    opts = opts || {};
    var THREE = root.THREE;
    if (!containerEl || !containerEl.appendChild || !THREE || !THREE.WebGLRenderer || !THREE.MeshPhysicalMaterial ||
        !THREE.PMREMGenerator || !THREE.BoxGeometry) return null;

    var reduced = typeof opts.reducedMotion === 'boolean' ? opts.reducedMotion : prefersReduced();
    var dprCap = typeof opts.dprCap === 'number' && opts.dprCap > 0 ? opts.dprCap : 2;

    var canvas = document.createElement('canvas');
    var gl = webglContext(canvas);
    if (!gl) return null;

    var renderer, scene, camera, envRT;
    var disposables = [];
    var u = {
      uSweepPos: { value: -10 }, uSweepAmt: { value: 0 }, uSweepWidth: { value: 0.17 },
      uSweepDir: { value: new THREE.Vector2(0.86, 0.51) }, uSweepOrigin: { value: new THREE.Vector3() },
      uSweepColor: { value: new THREE.Color(1.0, 0.93, 0.82) }, uEdgeGlow: { value: 1.35 },
      uFloorY: { value: FLOOR_Y }, uReflAmt: { value: 0.26 }, uReflFade: { value: 1.1 }, zero: { value: 0 },
      uCoreView: { value: new THREE.Vector3() }, uCoreAmt: { value: 0 }, uCoreColor: { value: new THREE.Color().setRGB(1.0, 0.42, 0.06) }
    };
    var group, reflRoot, cubes = [], reflCubes = [], mirror;
    var halo, backGlow, streak, ring, floorShadow, floorGlow, floorWarm, amberLight, keyLight, rimLight;

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, alpha: true, antialias: true, premultipliedAlpha: true });
      renderer.setClearColor(0x000000, 0);
      if ('outputEncoding' in renderer && THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      if ('physicallyCorrectLights' in renderer) renderer.physicallyCorrectLights = true;
      renderer.sortObjects = true;

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.5, 120);
      envRT = buildEnvironment(THREE, renderer);
      scene.environment = envRT.texture;

      // ----- logo -----
      group = new THREE.Group();
      scene.add(group);
      var geo = roundedCube(THREE, EDGE, RADIUS, 6);
      disposables.push(geo);
      var rmats = {};
      ['blue', 'deep', 'spark'].forEach(function (k) {
        rmats[k] = cubeMaterial(THREE, k, u, true);
        disposables.push(rmats[k]);
      });
      reflRoot = new THREE.Group();
      reflRoot.matrixAutoUpdate = false;
      scene.add(reflRoot);
      mirror = new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 2 * FLOOR_Y, 0, 0, 1, 0, 0, 0, 0, 1);
      SLOTS.forEach(function (s) {
        var mat = cubeMaterial(THREE, s.kind, u, false); // own material: per-cube fade-in during the intro
        disposables.push(mat);
        var mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(s.x, s.y, 0);
        mesh.renderOrder = 4;
        group.add(mesh);
        cubes.push(mesh);
        var rm = new THREE.Mesh(geo, rmats[s.kind]);
        rm.renderOrder = 2;
        reflRoot.add(rm);
        reflCubes.push(rm);
      });

      // ----- glows -----
      var soft = maskTexture(THREE, 128, function (r) { return Math.exp(-r * r * 4.2) * edgeFade(r); });
      var softer = maskTexture(THREE, 128, function (r) { return Math.exp(-r * r * 2.4) * edgeFade(r); });
      var ringTex = maskTexture(THREE, 256, function (r) { var d = (r - 0.82) / 0.05; return Math.exp(-d * d) * edgeFade(r * 0.9); });
      if (!soft || !softer || !ringTex) throw new Error('no 2d canvas');
      disposables.push(soft, softer, ringTex);

      backGlow = new THREE.Sprite(glowMaterial(THREE, softer, 0x3550F0, 0.0));
      backGlow.position.set(0, 0, -1.6);
      backGlow.scale.set(8, 8, 1);
      backGlow.renderOrder = 3;
      group.add(backGlow);

      halo = new THREE.Sprite(glowMaterial(THREE, soft, 0xFFA22E, 0.0));
      halo.position.set(0, 0, -0.62);
      halo.scale.set(3.6, 3.6, 1);
      halo.renderOrder = 5;
      group.add(halo);

      streak = new THREE.Sprite(glowMaterial(THREE, soft, 0xFFD9A0, 0.0));
      streak.material.depthTest = false;
      streak.position.set(0, 0, 0.8);
      streak.scale.set(10, 0.16, 1);
      streak.renderOrder = 9;
      group.add(streak);

      ring = new THREE.Sprite(glowMaterial(THREE, ringTex, 0xFFC46A, 0.0));
      ring.material.depthTest = false;
      ring.position.set(0, 0, 0.2);
      ring.renderOrder = 8;
      group.add(ring);
      [backGlow, halo, streak, ring].forEach(function (sp) { disposables.push(sp.material); });

      // ----- floor: contact shadow + light spill -----
      var pgeo = new THREE.PlaneGeometry(1, 1);
      disposables.push(pgeo);
      floorShadow = new THREE.Mesh(pgeo, planeMaterial(THREE, soft, 0x000000, 0.0, false));
      floorShadow.rotation.x = -Math.PI / 2;
      floorShadow.position.set(0, FLOOR_Y + 0.002, 0);
      floorShadow.scale.set(4.6, 2.2, 1);
      floorShadow.renderOrder = 0;
      floorGlow = new THREE.Mesh(pgeo, planeMaterial(THREE, softer, 0x4A66FF, 0.0, true));
      floorGlow.rotation.x = -Math.PI / 2;
      floorGlow.position.set(0, FLOOR_Y + 0.004, -0.2);
      floorGlow.scale.set(9, 4.2, 1);
      floorGlow.renderOrder = 1;
      floorWarm = new THREE.Mesh(pgeo, planeMaterial(THREE, soft, 0xFFA640, 0.0, true));
      floorWarm.rotation.x = -Math.PI / 2;
      floorWarm.position.set(0, FLOOR_Y + 0.006, 0);
      floorWarm.scale.set(3.4, 1.7, 1);
      floorWarm.renderOrder = 1;
      scene.add(floorShadow, floorGlow, floorWarm);
      disposables.push(floorShadow.material, floorGlow.material, floorWarm.material);

      // ----- lights -----
      keyLight = new THREE.DirectionalLight(0xFFF1E0, 1.5);
      keyLight.position.set(-4, 6, 7);
      rimLight = new THREE.DirectionalLight(0x6F8CFF, 3.2);
      rimLight.position.set(5, 3.5, -6);
      var fill = new THREE.HemisphereLight(0x8FA2FF, 0x0A0C18, 0.18);
      scene.add(keyLight, rimLight, fill);
      amberLight = new THREE.PointLight(0xFFA43A, 0, 0, 2);
      amberLight.position.set(0, 0, 0.32);
      group.add(amberLight);
    } catch (err) {
      try { disposables.forEach(function (d) { if (d && d.dispose) d.dispose(); }); } catch (e) { /* ignore */ }
      try { if (envRT) envRT.dispose(); } catch (e) { /* ignore */ }
      try { if (renderer) { renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); } } catch (e) { /* ignore */ }
      return null;
    }

    // ---------- DOM ----------
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('role', 'presentation');
    canvas.className = 'ph3d-canvas';
    var cs = canvas.style;
    cs.position = 'absolute'; cs.left = '0'; cs.top = '0'; cs.right = '0'; cs.bottom = '0';
    cs.width = '100%'; cs.height = '100%'; cs.display = 'block'; cs.pointerEvents = 'none';
    try {
      if (root.getComputedStyle && root.getComputedStyle(containerEl).position === 'static') containerEl.style.position = 'relative';
    } catch (e) { /* ignore */ }
    containerEl.appendChild(canvas);

    // ---------- state ----------
    var W = 0, H = 0, dpr = 1;
    var destroyed = false, paused = false, onScreen = true, docHidden = !!document.hidden, lost = false;
    var introOn = false, T = 0, clock = 0;
    var progT = 0, prog = 0, ptrTX = 0, ptrTY = 0, ptrX = 0, ptrY = 0;
    var raf = 0, lastNow = 0, firstFrame = true, oneShot = 0;
    var resolveReady;
    var ready = new Promise(function (res) { resolveReady = res; });
    var camDist = 10;

    function setSize() {
      var w = Math.max(1, Math.round(containerEl.clientWidth || 0));
      var h = Math.max(1, Math.round(containerEl.clientHeight || 0));
      var vw = root.innerWidth || w;
      var cap = dprCap;
      if (Math.min(vw, w) < 760) cap = Math.min(cap, 1.5);
      var d = Math.min(root.devicePixelRatio || 1, cap);
      if (w === W && h === H && d === dpr) return false;
      W = w; H = h; dpr = d;
      renderer.setPixelRatio(dpr);
      renderer.setSize(W, H, false);
      var aspect = W / H;
      camera.aspect = aspect;
      var t = Math.tan(FOV * Math.PI / 360);
      // logo height = FILL of the frame, but never wider than 62% of the frame
      var visH = Math.max(LOGO_H / FILL, LOGO_H / (0.62 * aspect));
      camDist = visH / (2 * t);
      camera.position.set(0, Math.sin(ELEV) * camDist, Math.cos(ELEV) * camDist);
      camera.lookAt(0, 0, 0);
      camera.near = Math.max(0.1, camDist * 0.05);
      camera.far = camDist + 80;
      camera.updateProjectionMatrix();
      return true;
    }

    // ---------- pose ----------
    function pose() {
      var still = reduced;
      var showing = still || introOn;
      var allIn = still || T >= INTRO_END;
      var p = still ? 0 : prog;
      var pe = p * p * (3 - 2 * p);

      // idle sway, ramped in after the intro so the cubes lock in facing the camera
      var amp = still ? 0 : smooth(1.5, 3.6, T);
      var yaw = still ? -0.3 : amp * (0.30 * Math.sin(clock * 0.53) + 0.07 * Math.sin(clock * 0.91 + 1.3));
      var pitch = still ? 0.075 : amp * (0.07 * Math.sin(clock * 0.67 + 0.6)) + 0.02 * amp;
      var bob = still ? 0 : amp * 0.07 * Math.sin(clock * 1.15);

      // slow cinematic push-in while the logo assembles
      var dolly = still ? 1 : 1 + 0.07 * (1 - smooth(0.2, 3.2, T));
      camera.position.set(0, Math.sin(ELEV) * camDist * dolly, Math.cos(ELEV) * camDist * dolly);

      group.position.set(0, bob + 1.45 * pe, -0.6 * pe);
      group.rotation.set(pitch + ptrY * 0.32 - 0.62 * pe, yaw + ptrX * 0.5 + 0.18 * pe, 0.1 * pe, 'XYZ');
      var sc = 1 - 0.12 * pe;
      group.scale.set(sc, sc, sc);

      // cubes
      var centreK = 0, centreTp = -1;
      for (var i = 0; i < SLOTS.length; i++) {
        var s = SLOTS[i], c = cubes[i];
        var spread = 1 + 0.5 * pe;
        var bx = s.x * spread + s.ex[0] * 0.15 * pe, by = s.y * spread + s.ex[1] * 0.15 * pe, bz = s.ex[2] * pe;
        var rx = s.er[0] * pe, ry = s.er[1] * pe, rz = s.er[2] * pe;
        var vis = true, op = 1;
        if (!allIn) {
          var tl = T - s.delay;
          if (tl <= 0) { vis = false; }
          else {
            var k = spring(tl, s.key === 'centre' ? 5.0 : 5.4, 0.6);       // depth: pushes past, settles back
            var kxy = spring(tl, 6.2, 0.88);                                   // lateral: near critical, no collisions
            var kr = spring(tl, 4.6, 0.8);                                     // tumble settle
            var sApp = S0 + (1 - S0) * k;
            var z = camDist * (1 - 1 / sApp);
            var far = 1 - kxy, ang = SWIRL * far, ca = Math.cos(ang), sa = Math.sin(ang);
            bx += (s.from[0] * ca - s.from[1] * sa) * far;
            by += (s.from[0] * sa + s.from[1] * ca) * far;
            bz += z;
            by += z * Math.tan(ELEV); // keep the vanishing point on the logo, not on the horizon
            rx += s.rot[0] * (1 - kr); ry += s.rot[1] * (1 - kr); rz += s.rot[2] * (1 - kr);
            op = smooth(0, 0.28, tl);
            if (s.key === 'centre') { centreK = k; centreTp = tl; }
          }
        }
        c.visible = vis && showing;
        c.position.set(bx, by, bz);
        c.rotation.set(rx, ry, rz);
        var m = c.material;
        var wantT = op < 0.999;
        if (m.transparent !== wantT) { m.transparent = wantT; m.depthWrite = true; }
        m.opacity = op;
      }

      // amber core: light, emissive, halo, landing flash
      var core = allIn ? 1 : smooth(0.55, 1.0, centreK) * (centreTp > 0 ? 1 : 0);
      var flash = 0;
      if (!still && introOn) {
        var tf = T - (SLOTS[4].delay + 0.62); // the centre cube's push-in peak
        if (tf > 0) flash = Math.exp(-tf * 4.2) * smooth(0, 0.06, tf);
      }
      var cubeSp = cubes[4];
      halo.position.set(cubeSp.position.x, cubeSp.position.y, cubeSp.position.z - 0.62);
      amberLight.position.set(cubeSp.position.x, cubeSp.position.y, cubeSp.position.z + 0.32);
      var breathe = still ? 1 : 1 + 0.06 * Math.sin(clock * 1.7);
      amberLight.intensity = core * (1.1 * breathe) + flash * 12;
      cubeSp.material.emissiveIntensity = (0.3 + 0.7 * core) * breathe + flash * 1.6;
      halo.material.opacity = core * 0.9 * breathe + flash * 0.6;
      var hs = 4.1 + flash * 2.4;
      halo.scale.set(hs, hs, 1);
      streak.material.opacity = flash * 0.85;
      streak.scale.set(6 + 9 * (1 - flash), 0.13 + 0.06 * flash, 1);
      streak.position.set(cubeSp.position.x, cubeSp.position.y, cubeSp.position.z + 0.8);
      var tr = flash > 0 ? (1 - flash) : 1;
      ring.material.opacity = flash > 0 ? 0.55 * flash * smooth(0, 0.15, 1 - flash) : 0;
      var rs = 1.2 + 6 * Math.sqrt(tr);
      ring.scale.set(rs, rs, 1);
      ring.position.copy(streak.position);
      ring.position.z -= 0.6;
      var outerIn = allIn ? 1 : smooth(0.35, 1.6, T);
      backGlow.material.opacity = showing ? 0.16 * outerIn * (1 - 0.5 * pe) : 0;
      halo.visible = showing; streak.visible = showing && flash > 0.002; ring.visible = streak.visible;

      // floor
      var lift = 1 - pe;
      var nearF = 1 - bob * 1.5;
      floorShadow.material.opacity = showing ? 0.55 * outerIn * lift * nearF : 0;
      floorGlow.material.opacity = showing ? 0.11 * outerIn * lift : 0;
      floorWarm.material.opacity = showing ? (0.2 * core * breathe + 0.35 * flash) * lift * nearF : 0;
      var fs = 1 + bob * 0.8;
      floorShadow.scale.set(4.4 * fs, 2.0 * fs, 1);

      // light sweep
      var sweepAmt = 0, sweepPos = -10;
      if (!still && T > SWEEP_FIRST) {
        var ph = (T - SWEEP_FIRST) % SWEEP_PERIOD;
        if (ph < SWEEP_DUR) {
          var x = ph / SWEEP_DUR;
          sweepPos = -3.4 + 6.8 * easeInOut(x);
          sweepAmt = Math.pow(Math.sin(Math.PI * x), 1.2);
        }
      }
      u.uSweepAmt.value = sweepAmt;
      u.uSweepPos.value = sweepPos;
      group.updateMatrixWorld(true);
      u.uSweepOrigin.value.setFromMatrixPosition(group.matrixWorld);
      camera.updateMatrixWorld();
      u.uCoreView.value.setFromMatrixPosition(cubeSp.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      u.uCoreAmt.value = core * 1.25 * breathe + flash * 2.5;

      // reflection: mirror the logo across the floor plane
      reflRoot.visible = showing;
      if (showing) {
        reflRoot.matrix.multiplyMatrices(mirror, group.matrixWorld);
        reflRoot.matrixWorldNeedsUpdate = true;
        for (var j = 0; j < cubes.length; j++) {
          var rc = reflCubes[j], cc = cubes[j];
          rc.visible = cc.visible && cc.material.opacity > 0.5;
          rc.position.copy(cc.position);
          rc.rotation.copy(cc.rotation);
        }
      }
      u.uReflAmt.value = 0.26 * (1 - 0.6 * pe);
    }

    function render() {
      if (destroyed || lost) return;
      // compile every program up front (hidden cubes included) so the intro never hitches on a shader compile
      if (firstFrame && renderer.compile) { try { renderer.compile(scene, camera); } catch (e) { /* render compiles lazily */ } }
      renderer.render(scene, camera);
      if (firstFrame) { firstFrame = false; resolveReady(true); }
    }

    function frame(dt) {
      if (!reduced) {
        if (introOn) T += dt;
        clock += dt;
        prog = damp(prog, progT, 9, dt);
        if (Math.abs(prog - progT) < 1e-4) prog = progT;
        ptrX = damp(ptrX, ptrTX, 3.2, dt);
        ptrY = damp(ptrY, ptrTY, 3.2, dt);
      }
      pose();
      render();
    }

    function shouldLoop() {
      return !destroyed && !paused && !lost && onScreen && !docHidden && !reduced && introOn;
    }
    function tick(now) {
      raf = 0;
      if (!shouldLoop()) { lastNow = 0; return; }
      raf = root.requestAnimationFrame(tick);
      var dt = lastNow ? (now - lastNow) / 1000 : 1 / 60;
      lastNow = now;
      frame(clamp(dt, 0, 0.1));
    }
    function updateLoop() {
      if (shouldLoop()) { if (!raf) { lastNow = 0; raf = root.requestAnimationFrame(tick); } }
      else if (raf) { root.cancelAnimationFrame(raf); raf = 0; lastNow = 0; }
    }
    // single render on the next frame (first frame, resizes while not looping, reduced motion)
    function requestStill() {
      if (destroyed || oneShot || raf) return;
      oneShot = root.requestAnimationFrame(function () {
        oneShot = 0;
        if (destroyed || raf) return;
        frame(0);
      });
    }

    // ---------- observers ----------
    setSize();
    var ro = null, io = null;
    // resizing clears the canvas, so redraw right away (same frame) instead of flashing an empty canvas
    function onResize() { if (setSize() && !destroyed && !lost) { pose(); render(); } }
    if (root.ResizeObserver) {
      ro = new root.ResizeObserver(onResize);
      ro.observe(containerEl);
    }
    function onWinResize() { onResize(); }
    root.addEventListener('resize', onWinResize);
    if (root.IntersectionObserver) {
      io = new root.IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];
        onScreen = !!(e && e.isIntersecting);
        updateLoop();
      }, { rootMargin: '120px 0px' });
      io.observe(containerEl);
    }
    function onVis() { docHidden = !!document.hidden; updateLoop(); }
    document.addEventListener('visibilitychange', onVis);
    function onLost(e) { if (e && e.preventDefault) e.preventDefault(); lost = true; updateLoop(); }
    function onRestored() {
      lost = false;
      try {
        if (envRT) envRT.dispose();
        envRT = buildEnvironment(THREE, renderer);
        scene.environment = envRT.texture;
      } catch (e) { /* keep going without a fresh env */ }
      requestStill();
      updateLoop();
    }
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);

    requestStill();

    // ---------- controller ----------
    var ctl = {
      ready: ready,
      canvas: canvas,
      intro: function () {
        if (destroyed || introOn) return ctl;
        if (reduced) { requestStill(); return ctl; }
        introOn = true; T = 0;
        updateLoop();
        return ctl;
      },
      setProgress: function (p) {
        p = +p;
        if (!(p === p)) return ctl; // NaN guard
        progT = clamp(p, 0, 1);
        return ctl;
      },
      setPointer: function (x, y) {
        x = +x; y = +y;
        if (x === x) ptrTX = clamp(x, -0.5, 0.5);
        if (y === y) ptrTY = clamp(y, -0.5, 0.5);
        return ctl;
      },
      pause: function () { paused = true; updateLoop(); return ctl; },
      resume: function () { if (destroyed) return ctl; paused = false; updateLoop(); if (!raf) requestStill(); return ctl; },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (raf) root.cancelAnimationFrame(raf);
        if (oneShot) root.cancelAnimationFrame(oneShot);
        raf = oneShot = 0;
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        root.removeEventListener('resize', onWinResize);
        document.removeEventListener('visibilitychange', onVis);
        canvas.removeEventListener('webglcontextlost', onLost, false);
        canvas.removeEventListener('webglcontextrestored', onRestored, false);
        try {
          disposables.forEach(function (d) { if (d && d.dispose) d.dispose(); });
          if (envRT) envRT.dispose();
          renderer.dispose();
          if (renderer.forceContextLoss) renderer.forceContextLoss();
        } catch (e) { /* ignore */ }
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        resolveReady(false);
      }
    };
    return ctl;
  }

  root.PixelHero3D = { mount: mount, version: '1.0.0' };
})(typeof window !== 'undefined' ? window : this);
