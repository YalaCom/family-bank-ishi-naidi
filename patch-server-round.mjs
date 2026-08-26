import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function once(text, from, to, label) {
  const i = text.indexOf(from);
  if (i < 0) throw new Error(`Server-round patch missing: ${label}`);
  if (text.indexOf(from, i + from.length) >= 0) throw new Error(`Server-round patch ambiguous: ${label}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

let js = await readFile("game/game.js", "utf8");
if (!js.includes("SERVER_ROUND_FAMILY_BANK_V2")) {
  js = once(
    js,
    `  /* ------------------------------------------------------------------ */\n  /* Round construction                                                  */\n  /* ------------------------------------------------------------------ */`,
    `  // SERVER_ROUND_FAMILY_BANK_V2 — реальный раунд выдаёт backend Family Bank.\n  function placedAt(obj, s, target) {\n    return {\n      id: obj.id, nx: s.nx, ny: s.ny, spawnId: s.id, target: !!target,\n      size: Math.max(42, Math.round(obj.size * (Number(s.scale) || 1))),\n      opacity: Number(s.opacity) || 1, rotate: Number(s.rotate) || 0,\n    };\n  }\n\n  /* ------------------------------------------------------------------ */\n  /* Round construction                                                  */\n  /* ------------------------------------------------------------------ */`,
    "placedAt helper"
  );

  js = once(
    js,
    `    const placed = [\n      { id: targetId, nx: spawn.nx, ny: spawn.ny, spawnId: spawn.id, target: true, size: target.size },\n    ];`,
    `    const placed = [placedAt(target, spawn, true)];`,
    "target placement"
  );
  js = once(
    js,
    `      placed.push({ id: obj.id, nx: s.nx, ny: s.ny, spawnId: s.id, target: false, size: obj.size });`,
    `      placed.push(placedAt(obj, s, false));`,
    "decoy placement"
  );

  js = once(
    js,
    `  function startPayload(r) {`,
    `  function roundFromServer(raw) {\n    if (!raw || !raw.roundId) throw new Error("Сервер не вернул раунд");\n    const mapId = String(raw.mapId || "");\n    const targetId = String(raw.targetId || "");\n    const spawnId = String(raw.spawnId || "");\n    const map = MAPS[mapId];\n    const target = OBJECTS[targetId];\n    const spawns = SPAWNS[mapId] || [];\n    const spawn = spawns.find((s) => s.id === spawnId);\n    if (!map || !target || !spawn || !intersects(target.zones, spawn.zones)) throw new Error("Некорректный раунд");\n\n    const seed = Number(raw.seed) >>> 0;\n    const rng = mulberry32(seed ^ 0x9e3779b9);\n    const used = {};\n    used[spawn.id] = true;\n    const placed = [placedAt(target, spawn, true)];\n    const eligible = Object.keys(OBJECTS).filter((id) => {\n      const obj = OBJECTS[id];\n      return !obj.rare && spawns.some((s) => intersects(obj.zones, s.zones));\n    }).filter((id) => id !== targetId);\n\n    let guard = 0;\n    while (placed.length < C.DECOY_COUNT + 1 && guard < 180) {\n      guard++;\n      const id = eligible[Math.floor(rng() * eligible.length)];\n      if (!id || placed.some((p) => p.id === id)) continue;\n      const obj = OBJECTS[id];\n      const options = spawns.filter((s) => !used[s.id] && intersects(obj.zones, s.zones));\n      if (!options.length) continue;\n      const s = options[Math.floor(rng() * options.length)];\n      const tooClose = placed.some((p) => Math.hypot(p.nx - s.nx, p.ny - s.ny) < C.MIN_SPAWN_DISTANCE);\n      if (tooClose) continue;\n      used[s.id] = true;\n      placed.push(placedAt(obj, s, false));\n    }\n\n    return {\n      id: String(raw.roundId), mapId, targetId, spawnId, nx: Number(spawn.nx), ny: Number(spawn.ny),\n      seed, startedAt: Number(raw.startedAt) || Date.now(), mistakes: 0, hintsUsed: 0,\n      placed, result: null, consumed: false,\n    };\n  }\n\n  function startPayload(r) {`,
    "server round constructor"
  );

  js = once(
    js,
    `      img.style.objectFit = "contain";\n      layer.appendChild(img);`,
    `      img.style.objectFit = "contain";\n      img.style.opacity = String(p.opacity == null ? 1 : p.opacity);\n      img.style.setProperty("--spawn-rot", (p.rotate || 0) + "deg");\n      layer.appendChild(img);`,
    "per-spawn visual blending"
  );

  js = once(
    js,
    `    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;\n    const r = pickRound(seed);\n\n    if (typeof host.onRoundStart === "function") {\n      try {\n        const res = await host.onRoundStart(startPayload(r));\n        if (res === false || (res && res.ok === false)) {\n          toast((res && res.reason) || "Нельзя начать раунд");\n          if (remaining() <= 0) showLimit();\n          return;\n        }\n      } catch (_) {}\n    }`,
    `    let r = null;\n    if (!host.demo && typeof host.onRoundStart === "function") {\n      try {\n        const res = await host.onRoundStart({\n          game: C.GAME_ID, userId: save.userId, demo: false,\n          telegramInitData: host.telegram && host.telegram.initData ? host.telegram.initData : "",\n        });\n        if (!res || res.ok === false || !res.round) {\n          toast((res && (res.reason || res.error)) || "Нельзя начать раунд");\n          if (remaining() <= 0) showLimit();\n          return;\n        }\n        r = roundFromServer(res.round);\n        if (typeof res.attemptsLeft === "number") host.attemptsLeft = Math.max(0, res.attemptsLeft);\n      } catch (e) {\n        toast((e && e.message) || "Не удалось начать игру");\n        return;\n      }\n    } else {\n      const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;\n      r = pickRound(seed);\n    }`,
    "server-authoritative start"
  );

  await writeFile("game/game.js", js, "utf8");
}

let css = await readFile("game/game.css", "utf8");
if (!css.includes("SPAWN_ROTATION_FAMILY_BANK_V2")) {
  css = once(
    css,
    `  transform: translate(-50%, -70%);`,
    `  /* SPAWN_ROTATION_FAMILY_BANK_V2 */\n  transform: translate(-50%, -70%) rotate(var(--spawn-rot, 0deg));`,
    "spawn rotation CSS"
  );
  await writeFile("game/game.css", css, "utf8");
}

const check = spawnSync(process.execPath, ["--check", "game/game.js"], { encoding: "utf8" });
if (check.status !== 0) throw new Error(check.stderr || check.stdout || "game.js syntax failed");
for (const marker of ["SERVER_ROUND_FAMILY_BANK_V2", "roundFromServer", "SPAWN_ROTATION_FAMILY_BANK_V2"]) {
  const all = js + "\n" + css;
  if (!all.includes(marker)) throw new Error(`Expected marker missing: ${marker}`);
}
console.log("Server-authoritative rounds and per-spawn blending applied.");
