import { readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";

const data = await readFile("game/js/data.js", "utf8");
const context = { window: { FBG: {} } };
vm.createContext(context);
vm.runInContext(data, context, { filename: "game/js/data.js" });
const fbg = context.window.FBG;

const objects = {};
for (const [id, obj] of Object.entries(fbg.OBJECTS || {})) {
  objects[id] = { zones: Array.isArray(obj.zones) ? obj.zones : [], rare: Boolean(obj.rare) };
}

const spawns = {};
for (const [mapId, list] of Object.entries(fbg.SPAWNS || {})) {
  spawns[mapId] = (list || []).map((s) => ({
    id: String(s.id),
    nx: Number(s.nx),
    ny: Number(s.ny),
    zones: Array.isArray(s.zones) ? s.zones : [],
  }));
}

const manifest = {
  version: 2,
  game: "seek",
  reward: 15,
  attemptsPerDay: 2,
  roundSeconds: 90,
  mistakesMax: 3,
  hintsPerRound: 1,
  maps: Array.from(fbg.MAP_ORDER || Object.keys(fbg.MAPS || {})),
  objects,
  spawns,
};

await writeFile("game/server-manifest.json", JSON.stringify(manifest), "utf8");
console.log(`Server manifest generated: ${Object.keys(objects).length} objects, ${Object.values(spawns).reduce((n, x) => n + x.length, 0)} spawns`);
