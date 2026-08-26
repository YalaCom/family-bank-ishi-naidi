/* Ищи-найди — runtime.
 * Внутреннее состояние раунда закрыто в IIFE: window.FamilyBankGame.win()
 * из консоли не завершает раунд и не шлёт победу.
 */
(function () {
  "use strict";

  const C = FBG.CONFIG;
  const OBJECTS = FBG.OBJECTS;
  const MAPS = FBG.MAPS;
  const SPAWNS = FBG.SPAWNS;

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ */
  /* Closed state                                                        */
  /* ------------------------------------------------------------------ */
  const host = {
    userId: null,
    attemptsLeft: null,
    attemptsMax: C.ATTEMPTS_PER_DAY,
    dayKey: null,
    displayReward: C.DISPLAY_REWARD,
    displayCurrency: C.DISPLAY_CURRENCY,
    onRoundStart: null,
    onResult: null,
    nextResetAt: null,
    demo: true,
    telegram: null,
  };

  let save = null;
  let round = null;
  let paused = false;
  let assetsReady = false;
  let limitTimer = 0;

  const camera = { tx: 0, ty: 0, scale: 1 };
  let camAnim = null;
  let reducedMotion = false;

  const pointers = new Map();
  let movedPx = 0;
  let downAt = 0;
  let lastTapAt = 0;
  let pinchDist = 0;
  let pinchScale = 1;

  let audioCtx = null;
  let sfxBus = null;
  let masterBus = null;

  /* ------------------------------------------------------------------ */
  /* Utils                                                               */
  /* ------------------------------------------------------------------ */
  function dayKeyNow() {
    if (host.dayKey) return host.dayKey;
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function nextResetMs() {
    if (host.nextResetAt) return new Date(host.nextResetAt).getTime();
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return ("00000000" + h.toString(16)).slice(-8);
  }

  function intersects(a, b) {
    for (let i = 0; i < a.length; i++) if (b.indexOf(a[i]) !== -1) return true;
    return false;
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function formatHMS(ms) {
    ms = Math.max(0, ms);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */
  function defaultSave(userId) {
    return {
      version: C.STORAGE_VERSION,
      userId: userId,
      dayKey: dayKeyNow(),
      attemptsUsed: 0,
      totalWins: 0,
      todayWins: 0,
      foundIds: [],
      lastMapId: null,
      rounds: [],
      inProgress: null,
      sound: true,
    };
  }

  function persist() {
    try {
      localStorage.setItem(C.STORAGE_KEY, JSON.stringify(save));
    } catch (_) {}
  }

  function loadSave(userId) {
    let data = defaultSave(userId);
    try {
      const raw = JSON.parse(localStorage.getItem(C.STORAGE_KEY) || "null");
      if (raw && raw.version === C.STORAGE_VERSION && raw.userId === userId) {
        data = Object.assign(data, raw);
      }
    } catch (_) {}
    if (data.dayKey !== dayKeyNow()) {
      data.dayKey = dayKeyNow();
      data.attemptsUsed = 0;
      data.todayWins = 0;
      data.rounds = [];
      data.inProgress = null;
    }
    return data;
  }

  function remaining() {
    if (typeof host.attemptsLeft === "number") return Math.max(0, host.attemptsLeft);
    return Math.max(0, host.attemptsMax - save.attemptsUsed);
  }

  /* ------------------------------------------------------------------ */
  /* Audio                                                               */
  /* ------------------------------------------------------------------ */
  function unlockAudio() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        masterBus = audioCtx.createGain();
        sfxBus = audioCtx.createGain();
        sfxBus.connect(masterBus);
        masterBus.connect(audioCtx.destination);
        masterBus.gain.value = 0.75;
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (_) {}
  }

  function tone(freq, dur, type, vol, delay, slide) {
    if (!audioCtx || !save || save.sound === false) return;
    const t0 = audioCtx.currentTime + (delay || 0);
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.1, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(sfxBus);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  const SFX = {
    tap: () => tone(920 + Math.random() * 80, 0.05, "triangle", 0.06),
    miss: () => {
      tone(220, 0.12, "square", 0.07);
      tone(160, 0.16, "sine", 0.05, 0.04);
    },
    win: () => {
      tone(523, 0.12, "sine", 0.09);
      tone(659, 0.12, "sine", 0.09, 0.1);
      tone(784, 0.16, "sine", 0.1, 0.2);
      tone(1046, 0.28, "triangle", 0.08, 0.32);
    },
    lose: () => {
      tone(392, 0.18, "sine", 0.08, 0, 247);
      tone(247, 0.3, "triangle", 0.07, 0.16, 174);
    },
    hint: () => tone(740, 0.18, "sine", 0.07),
    start: () => {
      tone(392, 0.1, "sine", 0.06);
      tone(523, 0.14, "sine", 0.07, 0.08);
    },
  };

  /* ------------------------------------------------------------------ */
  /* Camera                                                              */
  /* ------------------------------------------------------------------ */
  const viewport = () => $("viewport");
  const world = () => $("world");

  function viewSize() {
    const el = viewport();
    return { w: el.clientWidth, h: el.clientHeight };
  }

  function minScale() {
    const v = viewSize();
    return Math.max(v.w / C.MAP_WIDTH, v.h / C.MAP_HEIGHT);
  }

  function clampCam() {
    const v = viewSize();
    const w = C.MAP_WIDTH * camera.scale;
    const h = C.MAP_HEIGHT * camera.scale;
    if (w <= v.w) camera.tx = (v.w - w) / 2;
    else camera.tx = clamp(camera.tx, v.w - w, 0);
    if (h <= v.h) camera.ty = (v.h - h) / 2;
    else camera.ty = clamp(camera.ty, v.h - h, 0);
  }

  function applyCam() {
    world().style.transform = "translate(" + camera.tx + "px," + camera.ty + "px) scale(" + camera.scale + ")";
  }

  function zoomAt(cx, cy, next) {
    const s0 = camera.scale;
    const s1 = clamp(next, minScale(), C.MAX_ZOOM);
    const wx = (cx - camera.tx) / s0;
    const wy = (cy - camera.ty) / s0;
    camera.scale = s1;
    camera.tx = cx - wx * s1;
    camera.ty = cy - wy * s1;
    clampCam();
    applyCam();
  }

  function centerOn(nx, ny, scale) {
    const v = viewSize();
    camera.scale = clamp(scale || camera.scale, minScale(), C.MAX_ZOOM);
    camera.tx = v.w / 2 - nx * C.MAP_WIDTH * camera.scale;
    camera.ty = v.h / 2 - ny * C.MAP_HEIGHT * camera.scale;
    clampCam();
    applyCam();
  }

  function animateCam(nx, ny, scale, ms) {
    if (reducedMotion) {
      centerOn(nx, ny, scale);
      return;
    }
    const v = viewSize();
    const s1 = clamp(scale, minScale(), C.MAX_ZOOM);
    camAnim = {
      x0: camera.tx,
      y0: camera.ty,
      s0: camera.scale,
      x1: v.w / 2 - nx * C.MAP_WIDTH * s1,
      y1: v.h / 2 - ny * C.MAP_HEIGHT * s1,
      s1: s1,
      t0: performance.now(),
      dur: ms || 520,
    };
  }

  function stepCam(now) {
    if (!camAnim) return;
    const u = clamp((now - camAnim.t0) / camAnim.dur, 0, 1);
    const e = 1 - Math.pow(1 - u, 3);
    camera.tx = camAnim.x0 + (camAnim.x1 - camAnim.x0) * e;
    camera.ty = camAnim.y0 + (camAnim.y1 - camAnim.y0) * e;
    camera.scale = camAnim.s0 + (camAnim.s1 - camAnim.s0) * e;
    clampCam();
    applyCam();
    if (u >= 1) camAnim = null;
  }

  // SERVER_ROUND_FAMILY_BANK_V2 — реальный раунд выдаёт backend Family Bank.
  function placedAt(obj, s, target) {
    return {
      id: obj.id, nx: s.nx, ny: s.ny, spawnId: s.id, target: !!target,
      size: Math.max(42, Math.round(obj.size * (Number(s.scale) || 1))),
      opacity: Number(s.opacity) || 1, rotate: Number(s.rotate) || 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Round construction                                                  */
  /* ------------------------------------------------------------------ */
  function pickRound(seed) {
    const rng = mulberry32(seed);
    const last = save.lastMapId;
    let maps = FBG.MAP_ORDER.slice();
    if (last && maps.length > 1) maps = maps.filter((id) => id !== last);
    const mapId = maps[Math.floor(rng() * maps.length)];
    const spawns = SPAWNS[mapId].slice();

    const eligible = Object.keys(OBJECTS).filter((id) => {
      const obj = OBJECTS[id];
      return spawns.some((s) => intersects(obj.zones, s.zones));
    });

    let targetId;
    if (rng() < 0.1 && eligible.indexOf("golden_key") !== -1) targetId = "golden_key";
    else {
      const pool = eligible.filter((id) => !OBJECTS[id].rare);
      targetId = pool[Math.floor(rng() * pool.length)];
    }
    const target = OBJECTS[targetId];
    const tSpawns = spawns.filter((s) => intersects(target.zones, s.zones));
    const spawn = tSpawns[Math.floor(rng() * tSpawns.length)];

    const used = {};
    used[spawn.id] = true;
    const placed = [placedAt(target, spawn, true)];

    const decoyPool = eligible.filter((id) => id !== targetId && !OBJECTS[id].rare);
    let guard = 0;
    while (placed.length < C.DECOY_COUNT + 1 && guard < 80) {
      guard++;
      const id = decoyPool[Math.floor(rng() * decoyPool.length)];
      if (placed.some((p) => p.id === id)) continue;
      const obj = OBJECTS[id];
      const options = spawns.filter((s) => !used[s.id] && intersects(obj.zones, s.zones));
      if (!options.length) continue;
      const s = options[Math.floor(rng() * options.length)];
      const tooClose = placed.some((p) => Math.hypot(p.nx - s.nx, p.ny - s.ny) < C.MIN_SPAWN_DISTANCE);
      if (tooClose) continue;
      used[s.id] = true;
      placed.push(placedAt(obj, s, false));
    }

    return {
      id: uid(),
      mapId: mapId,
      targetId: targetId,
      spawnId: spawn.id,
      nx: spawn.nx,
      ny: spawn.ny,
      seed: seed,
      startedAt: Date.now(),
      mistakes: 0,
      hintsUsed: 0,
      placed: placed,
      result: null,
      consumed: false,
    };
  }

  function roundFromServer(raw) {
    if (!raw || !raw.roundId) throw new Error("Сервер не вернул раунд");
    const mapId = String(raw.mapId || "");
    const targetId = String(raw.targetId || "");
    const spawnId = String(raw.spawnId || "");
    const map = MAPS[mapId];
    const target = OBJECTS[targetId];
    const spawns = SPAWNS[mapId] || [];
    const spawn = spawns.find((s) => s.id === spawnId);
    if (!map || !target || !spawn || !intersects(target.zones, spawn.zones)) throw new Error("Некорректный раунд");

    const seed = Number(raw.seed) >>> 0;
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const used = {};
    used[spawn.id] = true;
    const placed = [placedAt(target, spawn, true)];
    const eligible = Object.keys(OBJECTS).filter((id) => {
      const obj = OBJECTS[id];
      return !obj.rare && spawns.some((s) => intersects(obj.zones, s.zones));
    }).filter((id) => id !== targetId);

    let guard = 0;
    while (placed.length < C.DECOY_COUNT + 1 && guard < 180) {
      guard++;
      const id = eligible[Math.floor(rng() * eligible.length)];
      if (!id || placed.some((p) => p.id === id)) continue;
      const obj = OBJECTS[id];
      const options = spawns.filter((s) => !used[s.id] && intersects(obj.zones, s.zones));
      if (!options.length) continue;
      const s = options[Math.floor(rng() * options.length)];
      const tooClose = placed.some((p) => Math.hypot(p.nx - s.nx, p.ny - s.ny) < C.MIN_SPAWN_DISTANCE);
      if (tooClose) continue;
      used[s.id] = true;
      placed.push(placedAt(obj, s, false));
    }

    return {
      id: String(raw.roundId), mapId, targetId, spawnId, nx: Number(spawn.nx), ny: Number(spawn.ny),
      seed, startedAt: Number(raw.startedAt) || Date.now(), mistakes: 0, hintsUsed: 0,
      placed, result: null, consumed: false,
    };
  }

  function startPayload(r) {
    return {
      game: C.GAME_ID,
      roundId: r.id,
      userId: save.userId,
      mapId: r.mapId,
      targetId: r.targetId,
      spawnId: r.spawnId,
      nx: r.nx,
      ny: r.ny,
      seed: r.seed,
      startedAt: r.startedAt,
      durationSec: C.ROUND_SECONDS,
      demo: host.demo,
      telegramInitData: host.telegram && host.telegram.initData ? host.telegram.initData : "",
    };
  }

  function makeProof(r, extra) {
    const raw = [
      r.id,
      C.GAME_ID,
      r.mapId,
      r.targetId,
      r.spawnId,
      String(r.startedAt),
      String(extra.endedAt),
      extra.result,
      extra.clickNx.toFixed(4),
      extra.clickNy.toFixed(4),
      String(r.mistakes),
      String(extra.durationMs),
      String(r.seed),
      C.CLIENT_SALT,
    ].join("|");
    return { alg: "djb2", hex: djb2(raw), len: raw.length };
  }

  function emitResult(payload) {
    try {
      if (typeof host.onResult === "function") host.onResult(payload);
    } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("familybank:game-result", { detail: payload }));
    } catch (_) {}
  }

  function finishRound(result, reason, click) {
    if (!round || round.result) return;
    const r = round;
    r.result = result;
    r.consumed = true;
    paused = false;
    const pauseEl = $("screen-pause");
    if (pauseEl) pauseEl.classList.remove("active");
    const endedAt = Date.now();
    const clickNx = click ? click.nx : -1;
    const clickNy = click ? click.ny : -1;
    const payload = {
      game: C.GAME_ID,
      roundId: r.id,
      result: result,
      reason: reason,
      mapId: r.mapId,
      targetId: r.targetId,
      spawnId: r.spawnId,
      click: { nx: clickNx, ny: clickNy },
      durationMs: endedAt - r.startedAt,
      mistakes: r.mistakes,
      hintsUsed: r.hintsUsed,
      seed: r.seed,
      startedAt: r.startedAt,
      endedAt: endedAt,
      demo: host.demo,
      proof: makeProof(r, {
        endedAt: endedAt,
        result: result,
        clickNx: clickNx,
        clickNy: clickNy,
        durationMs: endedAt - r.startedAt,
      }),
    };

    save.inProgress = null;
    save.lastMapId = r.mapId;
    save.rounds.push({
      roundId: r.id,
      result: result,
      mapId: r.mapId,
      targetId: r.targetId,
      at: endedAt,
    });
    if (result === "win") {
      save.totalWins += 1;
      save.todayWins += 1;
      if (save.foundIds.indexOf(r.targetId) === -1) save.foundIds.push(r.targetId);
    }
    persist();
    emitResult(payload);
    try {
      const hook = window.FamilyBankHost;
      if (hook) {
        if (result === "win" && typeof hook.win === "function") hook.win(payload);
        if (result === "lose" && typeof hook.lose === "function") hook.lose(payload);
      }
    } catch (_) {}

    if (result === "win") {
      SFX.win();
      highlightFound();
      window.setTimeout(function () {
        showWin();
      }, 720);
    } else {
      SFX.lose();
      showLose(reason);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rendering the round                                                 */
  /* ------------------------------------------------------------------ */
  function mountRound(r) {
    const map = MAPS[r.mapId];
    world().style.width = C.MAP_WIDTH + "px";
    world().style.height = C.MAP_HEIGHT + "px";
    const bg = $("map-bg");
    bg.src = map.src;
    bg.style.width = C.MAP_WIDTH + "px";
    bg.style.height = C.MAP_HEIGHT + "px";
    const layer = $("objects-layer");
    layer.style.width = C.MAP_WIDTH + "px";
    layer.style.height = C.MAP_HEIGHT + "px";
    layer.innerHTML = "";
    r.placed.forEach(function (p) {
      const obj = OBJECTS[p.id];
      const img = document.createElement("img");
      img.className = "world-obj";
      img.alt = "";
      img.draggable = false;
      img.src = obj.src;
      img.dataset.id = p.id;
      img.dataset.target = p.target ? "1" : "0";
      img.style.left = p.nx * C.MAP_WIDTH + "px";
      img.style.top = p.ny * C.MAP_HEIGHT + "px";
      img.style.width = p.size + "px";
      img.style.height = p.size + "px";
      img.style.objectFit = "contain";
      img.style.opacity = String(p.opacity == null ? 1 : p.opacity);
      img.style.setProperty("--spawn-rot", (p.rotate || 0) + "deg");
      layer.appendChild(img);
    });

    $("hud-map").textContent = map.name;
    $("target-img").src = OBJECTS[r.targetId].src;
    $("target-name").textContent = OBJECTS[r.targetId].name;
    $("btn-hint").disabled = r.hintsUsed >= C.HINTS_PER_ROUND;
    renderHearts();
    updateTimerHud();

    const awayX = r.nx > 0.5 ? 0.28 : 0.72;
    const startS = minScale() * C.START_ZOOM_EXTRA;
    centerOn(awayX, 0.52, startS);
  }

  function renderHearts() {
    const n = C.MISTAKES_MAX;
    const left = n - (round ? round.mistakes : 0);
    const html = [];
    for (let i = 0; i < n; i++) {
      html.push('<span class="heart' + (i < left ? "" : " off") + '"></span>');
    }
    $("hud-hearts").innerHTML = html.join("");
  }

  function updateTimerHud() {
    if (!round) return;
    const left = C.ROUND_SECONDS - (Date.now() - round.startedAt) / 1000;
    $("hud-time").textContent = formatTime(left);
    if (left <= 0 && !round.result && !paused) finishRound("lose", "timeout", null);
  }

  function highlightFound() {
    const el = $("objects-layer").querySelector('.world-obj[data-target="1"]');
    if (el) el.classList.add("found");
    if (!round) return;
    const ring = document.createElement("div");
    ring.className = "find-ring";
    ring.style.left = round.nx * C.MAP_WIDTH + "px";
    ring.style.top = round.ny * C.MAP_HEIGHT + "px";
    $("objects-layer").appendChild(ring);
    animateCam(round.nx, round.ny, Math.min(C.MAX_ZOOM, camera.scale * 1.55), 480);
  }

  /* ------------------------------------------------------------------ */
  /* Input                                                               */
  /* ------------------------------------------------------------------ */
  function localPoint(e) {
    const r = viewport().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function pointerMid() {
    const arr = Array.from(pointers.values());
    return { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
  }

  function onPointerDown(e) {
    if (!round || round.result || paused) return;
    if (e.target.closest && e.target.closest(".hud-top, .tray, .icon-btn, .btn")) return;
    unlockAudio();
    try {
      if (viewport().setPointerCapture) viewport().setPointerCapture(e.pointerId);
    } catch (_) {}
    const p = localPoint(e);
    pointers.set(e.pointerId, { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY });
    movedPx = 0;
    downAt = performance.now();
    if (pointers.size === 1) {
      viewport().classList.add("panning");
      camAnim = null;
    } else if (pointers.size === 2) {
      const a = Array.from(pointers.values());
      pinchDist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      pinchScale = camera.scale;
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localPoint(e);
    const prev = pointers.get(e.pointerId);
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    pointers.set(e.pointerId, { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY });
    if (pointers.size === 2) {
      const a = Array.from(pointers.values());
      const dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      const mid = pointerMid();
      zoomAt(mid.x, mid.y, pinchScale * (dist / pinchDist));
      movedPx += 12;
      return;
    }
    if (pointers.size === 1) {
      movedPx += Math.hypot(dx, dy);
      camera.tx += dx;
      camera.ty += dy;
      clampCam();
      applyCam();
    }
  }

  function onPointerUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const rec = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size === 0) viewport().classList.remove("panning");
    if (pointers.size === 1) {
      const a = Array.from(pointers.values());
      pinchDist = 1;
      pinchScale = camera.scale;
    }
    if (pointers.size > 0) return;
    if (!round || round.result || paused) return;
    const dt = performance.now() - downAt;
    if (movedPx < C.PAN_TAP_SLOP && dt < 450) {
      const now = performance.now();
      if (now - lastTapAt < C.DOUBLE_TAP_MS) {
        lastTapAt = 0;
        const p = localPoint(e);
        const mid = (minScale() + C.MAX_ZOOM) * 0.5;
        const next = camera.scale < mid ? camera.scale * 1.55 : minScale() * C.START_ZOOM_EXTRA;
        zoomAt(p.x, p.y, next);
        return;
      }
      lastTapAt = now;
      handleTap(rec.cx, rec.cy);
    }
  }

  function onWheel(e) {
    if (!round || round.result) return;
    e.preventDefault();
    const p = localPoint(e);
    const factor = Math.exp(-e.deltaY * C.WHEEL_ZOOM_STEP);
    zoomAt(p.x, p.y, camera.scale * factor);
  }

  function handleTap(clientX, clientY) {
    SFX.tap();
    const hit = hitTest(clientX, clientY);
    const world = screenToWorld(clientX, clientY);
    const click = { nx: world.x / C.MAP_WIDTH, ny: world.y / C.MAP_HEIGHT };
    if (!hit) {
      spawnRipple(world.x, world.y);
      if (C.EMPTY_TAP_PENALTY) registerMiss(click);
      return;
    }
    if (hit.dataset.target === "1") {
      finishRound("win", "found", click);
      return;
    }
    registerMiss(click);
  }

  function screenToWorld(clientX, clientY) {
    const r = viewport().getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    return { x: (sx - camera.tx) / camera.scale, y: (sy - camera.ty) / camera.scale };
  }

  function hitTest(clientX, clientY) {
    const els = $("objects-layer").querySelectorAll(".world-obj");
    let best = null;
    let bestD = Infinity;
    const pad = C.HIT_PADDING;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const box = el.getBoundingClientRect();
      if (
        clientX < box.left - pad ||
        clientX > box.right + pad ||
        clientY < box.top - pad ||
        clientY > box.bottom + pad
      )
        continue;
      const d = Math.hypot(clientX - (box.left + box.width / 2), clientY - (box.top + box.height / 2));
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return best;
  }

  function spawnRipple(x, y) {
    const el = document.createElement("div");
    el.className = "ripple";
    el.style.left = x + "px";
    el.style.top = y + "px";
    $("objects-layer").appendChild(el);
    window.setTimeout(function () {
      el.remove();
    }, 450);
  }

  function registerMiss(click) {
    if (!round || round.result) return;
    round.mistakes += 1;
    renderHearts();
    SFX.miss();
    toast("Не то");
    const tray = $("tray");
    tray.classList.remove("shake");
    void tray.offsetWidth;
    tray.classList.add("shake");
    if (round.mistakes >= C.MISTAKES_MAX) finishRound("lose", "mistakes", click);
  }

  function useHint() {
    if (!round || round.result || paused) return;
    if (round.hintsUsed >= C.HINTS_PER_ROUND) return;
    round.hintsUsed += 1;
    $("btn-hint").disabled = true;
    SFX.hint();
    const jitter = 0.07;
    const hx = clamp(round.nx + (Math.random() * 2 - 1) * jitter, 0.08, 0.92);
    const hy = clamp(round.ny + (Math.random() * 2 - 1) * jitter, 0.12, 0.88);
    animateCam(hx, hy, Math.min(C.MAX_ZOOM, Math.max(camera.scale, minScale() * 1.7)), 600);
    const pulse = document.createElement("div");
    pulse.className = "hint-pulse";
    pulse.style.left = hx * C.MAP_WIDTH + "px";
    pulse.style.top = hy * C.MAP_HEIGHT + "px";
    $("objects-layer").appendChild(pulse);
    window.setTimeout(function () {
      pulse.remove();
    }, 1600);
    toast("Ищи в этой стороне");
  }

  /* ------------------------------------------------------------------ */
  /* Screens                                                             */
  /* ------------------------------------------------------------------ */
  function hideAll() {
    document.querySelectorAll(".screen").forEach(function (s) {
      s.classList.remove("active");
    });
  }

  function showScreen(name, overlay) {
    if (!overlay) hideAll();
    const el = $("screen-" + name);
    if (el) el.classList.add("active");
  }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () {
      el.classList.remove("show");
    }, 1100);
  }

  function refreshHome() {
    const left = remaining();
    const max = host.attemptsMax;
    $("attempts-label").textContent = left + " / " + max;
    $("chip-wins").textContent = "Наград: " + save.totalWins;
    $("btn-play").disabled = false;
    $("demo-flag").hidden = !host.demo;
  }

  function refreshAttempts() {
    $("st-left").textContent = remaining() + " / " + host.attemptsMax;
    $("st-wins").textContent = String(save.totalWins);
    $("st-reset").textContent = "Обновление попыток: " + formatHMS(nextResetMs() - Date.now());
    const grid = $("found-grid");
    const found = save.foundIds.filter(function (id) {
      return OBJECTS[id];
    });
    if (!found.length) {
      grid.innerHTML = '<p style="grid-column:1/-1;margin:0;color:inherit;opacity:.7">Пока пусто — найдите первый предмет</p>';
      return;
    }
    grid.innerHTML = found
      .map(function (id) {
        return '<img src="' + OBJECTS[id].src + '" alt="' + OBJECTS[id].name + '" />';
      })
      .join("");
  }

  function showWin() {
    $("win-copy").textContent = host.demo
      ? "В демо награда не начисляется. В Family Bank её выдаст сервер."
      : "Сообщаем Family Bank о победе. Сумму назначит сервер.";
    $("win-reward").innerHTML = "+" + host.displayReward + " <small>" + host.displayCurrency + "</small>";
    $("win-left").textContent = "Осталось попыток: " + remaining();
    $("btn-play-again").style.display = remaining() <= 0 ? "none" : "";
    showScreen("win", true);
  }

  function showLose(reason) {
    const titles = {
      mistakes: "Слишком много ошибок",
      timeout: "Время вышло",
      quit: "Раунд прерван",
    };
    $("lose-title").textContent = titles[reason] || "Раунд окончен";
    $("lose-copy").textContent =
      reason === "quit" ? "Попытка уже использована." : "Предмет так и остался спрятан.";
    $("lose-left").textContent = "Осталось попыток: " + remaining();
    $("btn-lose-again").style.display = remaining() <= 0 ? "none" : "";
    showScreen("lose", true);
  }

  function showLimit() {
    showScreen("limit");
    tickLimit();
  }

  function tickLimit() {
    $("limit-cd").textContent = formatHMS(nextResetMs() - Date.now());
  }

  async function tryPlay() {
    unlockAudio();
    if (remaining() <= 0) {
      showLimit();
      return;
    }
    if (save.inProgress && C.ABANDON_COUNTS_AS_LOSE) {
      save.inProgress = null;
      persist();
    }
    let r = null;
    if (!host.demo && typeof host.onRoundStart === "function") {
      try {
        const res = await host.onRoundStart({
          game: C.GAME_ID, userId: save.userId, demo: false,
          telegramInitData: host.telegram && host.telegram.initData ? host.telegram.initData : "",
        });
        if (!res || res.ok === false || !res.round) {
          toast((res && (res.reason || res.error)) || "Нельзя начать раунд");
          if (remaining() <= 0) showLimit();
          return;
        }
        r = roundFromServer(res.round);
        if (typeof res.attemptsLeft === "number") host.attemptsLeft = Math.max(0, res.attemptsLeft);
      } catch (e) {
        toast((e && e.message) || "Не удалось начать игру");
        return;
      }
    } else {
      const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
      r = pickRound(seed);
    }

    if (C.CONSUME_ATTEMPT_ON_START) {
      save.attemptsUsed += 1;
      if (typeof host.attemptsLeft === "number") host.attemptsLeft = Math.max(0, host.attemptsLeft - 1);
    }
    save.inProgress = { roundId: r.id, startedAt: r.startedAt };
    persist();

    round = r;
    paused = false;
    showScreen("play");
    $("hud-map").textContent = "Загрузка…";
    loadImg(MAPS[r.mapId].src).then(function () {
      if (!round || round.id !== r.id) return;
      mountRound(r);
      SFX.start();
    });
  }

  function quitRound() {
    if (!round || round.result) {
      goHome();
      return;
    }
    finishRound("lose", "quit", null);
  }

  function goHome() {
    paused = false;
    round = null;
    pointers.clear();
    hideAll();
    refreshHome();
    showScreen("home");
  }

  /* ------------------------------------------------------------------ */
  /* Loop                                                                */
  /* ------------------------------------------------------------------ */
  function loop(now) {
    stepCam(now);
    if (round && !round.result) updateTimerHud();
    const lim = $("screen-limit");
    if (lim && lim.classList.contains("active")) {
      if (!limitTimer || now - limitTimer > 250) {
        limitTimer = now;
        tickLimit();
      }
    }
    requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------------------ */
  /* Telegram / host                                                     */
  /* ------------------------------------------------------------------ */
  function detectTelegram() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) return null;
    try {
      tg.ready();
      tg.expand();
      if (typeof tg.disableVerticalSwipes === "function") tg.disableVerticalSwipes();
      if (typeof tg.setHeaderColor === "function") tg.setHeaderColor("#1c241e");
      if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor("#1c241e");
    } catch (_) {}
    const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
    return {
      present: true,
      userId: user && user.id ? String(user.id) : null,
      initData: tg.initData || "",
    };
  }

  function applyHost(opts) {
    if (!opts) return;
    if (opts.userId) host.userId = String(opts.userId);
    if (typeof opts.attemptsLeft === "number") host.attemptsLeft = opts.attemptsLeft;
    if (typeof opts.attemptsMax === "number") host.attemptsMax = opts.attemptsMax;
    if (opts.dayKey) host.dayKey = opts.dayKey;
    if (opts.displayReward != null) host.displayReward = opts.displayReward;
    if (opts.displayCurrency) host.displayCurrency = opts.displayCurrency;
    if (typeof opts.onRoundStart === "function") host.onRoundStart = opts.onRoundStart;
    if (typeof opts.onResult === "function") host.onResult = opts.onResult;
    if (opts.nextResetAt) host.nextResetAt = opts.nextResetAt;
    if (opts.demo === false) host.demo = false;
    if (opts.userId || opts.attemptsLeft != null) host.demo = false;
  }

  function publicState() {
    return {
      game: C.GAME_ID,
      userId: save ? save.userId : host.userId,
      demo: host.demo,
      attemptsLeft: remaining(),
      attemptsMax: host.attemptsMax,
      totalWins: save ? save.totalWins : 0,
      dayKey: dayKeyNow(),
      roundActive: !!(round && !round.result),
      roundId: round && !round.result ? round.id : null,
    };
  }

  window.FamilyBankGame = {
    GAME_ID: C.GAME_ID,
    init: function (options) {
      applyHost(options || {});
      const uid = host.userId || C.DEMO_USER_ID;
      save = loadSave(uid);
      save.userId = uid;
      persist();
      refreshHome();
      return publicState();
    },
    getState: function () {
      return publicState();
    },
    startRound: function () {
      return tryPlay();
    },
    win: function () {
      try {
        console.warn("[FamilyBankGame] win() из консоли игнорируется. Награду выдаёт backend Family Bank после проверки proof.");
      } catch (_) {}
      return { ok: false, error: "client_win_ignored" };
    },
    lose: function () {
      return { ok: false, error: "client_lose_ignored" };
    },
    onResult: null,
  };

  Object.defineProperty(window.FamilyBankGame, "onResult", {
    set: function (fn) {
      host.onResult = fn;
    },
    get: function () {
      return host.onResult;
    },
  });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  function bind() {
    $("btn-play").addEventListener("click", function () {
      tryPlay();
    });
    $("btn-rules").addEventListener("click", function () {
      showScreen("rules");
    });
    $("btn-rules-close").addEventListener("click", goHome);
    $("btn-attempts").addEventListener("click", function () {
      refreshAttempts();
      showScreen("attempts");
    });
    $("btn-attempts-close").addEventListener("click", goHome);
    $("btn-pause").addEventListener("click", function () {
      if (!round || round.result) return;
      paused = true;
      showScreen("pause", true);
    });
    $("btn-resume").addEventListener("click", function () {
      paused = false;
      $("screen-pause").classList.remove("active");
    });
    $("btn-quit").addEventListener("click", quitRound);
    $("btn-hint").addEventListener("click", useHint);
    $("btn-play-again").addEventListener("click", function () {
      hideAll();
      tryPlay();
    });
    $("btn-lose-again").addEventListener("click", function () {
      hideAll();
      tryPlay();
    });
    $("btn-win-home").addEventListener("click", goHome);
    $("btn-lose-home").addEventListener("click", goHome);
    $("btn-limit-home").addEventListener("click", goHome);

    const vp = viewport();
    vp.addEventListener("pointerdown", onPointerDown);
    vp.addEventListener("pointermove", onPointerMove);
    vp.addEventListener("pointerup", onPointerUp);
    vp.addEventListener("pointercancel", onPointerUp);
    vp.addEventListener("wheel", onWheel, { passive: false });
    vp.addEventListener(
      "contextmenu",
      function (e) {
        e.preventDefault();
      },
      { passive: false }
    );

    window.addEventListener("pointerdown", unlockAudio, { once: true });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        persist();
        if (audioCtx && audioCtx.state === "running") audioCtx.suspend();
      } else if (audioCtx) {
        audioCtx.resume();
      }
    });
    window.addEventListener("resize", function () {
      if (!round) return;
      camera.scale = Math.max(camera.scale, minScale());
      clampCam();
      applyCam();
    });
  }

  function loadImg(src) {
    return new Promise(function (res) {
      const img = new Image();
      img.onload = img.onerror = function () {
        res(src);
      };
      img.src = src;
    });
  }

  function preloadCritical() {
    return loadImg("assets/ui/hero.jpg");
  }

  function preloadRest() {
    const urls = [];
    Object.keys(MAPS).forEach(function (id) {
      urls.push(MAPS[id].src);
    });
    Object.keys(OBJECTS).forEach(function (id) {
      urls.push(OBJECTS[id].src);
    });
    urls.forEach(function (src) {
      loadImg(src);
    });
  }

  function boot() {
    reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    host.telegram = detectTelegram();
    if (host.telegram && host.telegram.present) {
      host.demo = false;
      if (host.telegram.userId) host.userId = host.telegram.userId;
    }
    const q = new URLSearchParams(location.search);
    if (q.get("demo") === "1") host.demo = true;
    if (q.get("user")) host.userId = q.get("user");

    save = loadSave(host.userId || C.DEMO_USER_ID);
    bind();
    requestAnimationFrame(loop);
    if (save.inProgress && C.ABANDON_COUNTS_AS_LOSE) {
      save.inProgress = null;
      persist();
    }
    assetsReady = true;
    goHome();
    preloadRest();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
