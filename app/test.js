// Self-check for the generator logic. Run: node test.js
const fs = require("fs");
const path = require("path");
const G = require("./app.js");

const movements = JSON.parse(fs.readFileSync(path.join(__dirname, "movements.json"), "utf8")).movements;
const gym = JSON.parse(fs.readFileSync(path.join(__dirname, "gym.json"), "utf8"));
const DATA = { movements, gym };
const inv = gym.inventory;

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name, extra || ""); } }

function moveById(s, id) { return s.blocks.flatMap(b => b.items).find(i => i.movement.id === id); }
function allMoves(s) { return s.blocks.flatMap(b => b.items.map(i => i.movement)); }
function s1(s) { const b = s.blocks.find(b => b.name.startsWith("Strength 1")); return b ? b.items[0].movement : null; }

console.log("\n== Load rounding ==");
// Barbell: no 15/20 lb plates. 45lb bar + want ~135 -> 45 + 2*45 = 135 achievable.
ok("barbell 135 exact", G.nearestBarbell(135, 45, inv.plates_lb) === 135, G.nearestBarbell(135, 45, inv.plates_lb));
// Want 100 with 45 bar: 45 + 2*(25+2.5)=100. achievable.
ok("barbell 100 achievable", G.nearestBarbell(100, 45, inv.plates_lb) === 100, G.nearestBarbell(100, 45, inv.plates_lb));
// 75 is achievable: 45 bar + 2*(10+5)/side. Composing from small plates keeps a 5-lb grid
// even without 15/20 lb plates, so off-grid targets snap to the nearest 5.
ok("barbell 75 achievable (10+5 per side)", G.nearestBarbell(75, 45, inv.plates_lb) === 75, G.nearestBarbell(75, 45, inv.plates_lb));
ok("barbell 78 -> 80 (5-lb grid)", G.nearestBarbell(78, 45, inv.plates_lb) === 80, G.nearestBarbell(78, 45, inv.plates_lb));
ok("barbell 77 -> 75 (5-lb grid)", G.nearestBarbell(77, 45, inv.plates_lb) === 75, G.nearestBarbell(77, 45, inv.plates_lb));
// DB ladder snapping
ok("DB 38 -> 40", G.roundLoad(38, "dumbbell", inv, 45).valueLb === 40, JSON.stringify(G.roundLoad(38, "dumbbell", inv, 45)));
ok("DB 23 -> 22.5", G.roundLoad(23, "dumbbell", inv, 45).valueLb === 22.5, JSON.stringify(G.roundLoad(23, "dumbbell", inv, 45)));
// KB: target ~35 lb -> ~16kg
const kb = G.roundLoad(35, "kettlebell", inv, 45);
ok("KB ~35lb lands on a 2kg step", inv.kettlebells_kg.includes(Math.round(kb.valueLb / inv.kg_to_lb)) || /kg/.test(kb.display), JSON.stringify(kb));
// machine/bodyweight -> no load
ok("machine -> null load", G.roundLoad(100, "machine", inv, 45) === null);

console.log("\n== Freshness & balance ==");
const today = "2026-06-14"; // Sunday
const histHeavySquat = [
  { date: "2026-06-13", focus: "Squat & Pull", items: [{ movementId: "back-squat-bb", pattern: "squat", muscles: ["quads", "glutes"], intensity: "heavy" }] },
];
const { patternFatigue } = G.computeFatigue(histHeavySquat, today);
ok("squat fatigued after heavy day", patternFatigue.squat > 0);
ok("hinge fresh", !patternFatigue.hinge);
ok("squat less fresh than hinge", G.freshness("squat", patternFatigue) < G.freshness("hinge", patternFatigue));

console.log("\n== No heavy same-pattern back-to-back (auto focus) ==");
let squatNextDay = 0;
for (let seed = 1; seed <= 40; seed++) {
  const s = G.buildSession(DATA, { today, history: histHeavySquat, maxes: {}, settings: {}, seed });
  if (s1(s) && s1(s).pattern === "squat") squatNextDay++;
}
ok("rarely puts squat as S1 the day after heavy squats", squatNextDay <= 6, `${squatNextDay}/40`);

console.log("\n== Focus rotation (no back-to-back same focus) ==");
let repeats = 0;
for (let seed = 1; seed <= 40; seed++) {
  const h = [{ date: "2026-06-13", focus: "Hinge & Press", items: [{ movementId: "deadlift-bb", pattern: "hinge", muscles: ["glutes"], intensity: "heavy" }] }];
  const s = G.buildSession(DATA, { today, history: h, maxes: {}, settings: {}, seed });
  if (s.focus === "Hinge & Press") repeats++;
}
ok("auto focus avoids repeating yesterday's focus", repeats === 0, `${repeats}/40 repeated`);

console.log("\n== Scheduling: Sled only Fri-Sun, capped ==");
// Sunday (allowed): sled is a candidate; Tuesday (not allowed): filtered out.
const sun = G.filterCandidates(movements, { today: "2026-06-14", history: [], avoidList: [] }).some(m => m.id === "sled-push"); // Sun
const tue = G.filterCandidates(movements, { today: "2026-06-16", history: [], avoidList: [] }).some(m => m.id === "sled-push"); // Tue
ok("sled available on Sunday", sun);
ok("sled filtered out on Tuesday", !tue);
const recentSled = [{ date: "2026-06-13", focus: "Conditioning", items: [{ movementId: "sled-push", pattern: "carry", muscles: ["legs"], intensity: "light" }] }];
const capped = G.filterCandidates(movements, { today: "2026-06-14", history: recentSled, avoidList: [] }).some(m => m.id === "sled-push");
ok("sled respects frequency cap (used yesterday)", !capped);

console.log("\n== Avoid list ==");
const avoided = G.filterCandidates(movements, { today, history: [], avoidList: ["back-squat-bb"] }).some(m => m.id === "back-squat-bb");
ok("avoided movement is filtered out", !avoided);

console.log("\n== Swap: same region, different move ==");
const bsquat = movements.find(m => m.id === "back-squat-bb");
const swaps = G.swapCandidates(DATA, bsquat, "strength2", { today, history: [], avoidList: [] });
ok("swap returns same-region (lower) alternatives", swaps.length > 0 && swaps.every(m => m.region === "lower" && m.id !== "back-squat-bb"), swaps.slice(0,3).map(m=>m.id).join(","));

console.log("\n== Pathing: supersets stay within adjacent zones (ALL focuses) ==");
let badSuperset = 0, sessions = 0;
const FOCUSES = Object.keys(G.FOCUSES);
for (const focusOverride of FOCUSES) {
  for (let seed = 1; seed <= 30; seed++) {
    const s = G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, focusOverride, seed });
    const sup = s.blocks.find(b => b.name.startsWith("Strength 2"));
    if (sup && sup.items.length === 2) {
      sessions++;
      const d = G.pairZoneDistance(gym, sup.items[0].movement, sup.items[1].movement).dist;
      if (d > 1) badSuperset++;
    }
  }
}
ok("all generated supersets within distance <=1", badSuperset === 0, `${badSuperset}/${sessions} bad`);

console.log("\n== Auto focus varies across seeds (no degenerate default) ==");
const seenFocuses = new Set();
for (let seed = 1; seed <= 30; seed++) {
  seenFocuses.add(G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, seed }).focus);
}
ok("auto focus produces variety on a fresh week", seenFocuses.size >= 3, [...seenFocuses].join(","));

console.log("\n== Banded pull-ups resolve to rig zone B ==");
const pu = movements.find(m => m.id === "pull-up-banded");
ok("banded pull-up is zone B", pu.zones.length === 1 && pu.zones[0] === "B");

console.log("\n== Load suggestion uses maxes (his/hers) ==");
const maxes = { "back-squat-bb": { him: 315, her: 155 } };
const sug = G.loadSuggestion(bsquat, 5, maxes, { bars: { him: "mens", her: "womens" } }, inv);
ok("his squat 5-rep ~85% of 315 snaps to a barbell total", sug.him.valueLb > 250 && sug.him.valueLb < 280, JSON.stringify(sug.him));
ok("her squat uses 15kg bar option", /15kg/.test(sug.her.display), sug.her.display);

console.log("\n== Full session shape ==");
const full = G.buildSession(DATA, { today, history: [], maxes, settings: { bars: { him: "mens", her: "womens" } }, seed: 7 });
ok("has 4 blocks (warmup/s1/s2/metcon)", full.blocks.length === 4, full.blocks.map(b => b.name).join(" | "));
ok("zonePath is defined", Array.isArray(full.zonePath) && full.zonePath.length >= 1, JSON.stringify(full.zonePath));
ok("history round-trip produces items", G.sessionToHistoryEntry(full).items.length > 0);

console.log("\n== No duplicate movement within a session ==");
let dupes = 0;
for (let seed = 1; seed <= 50; seed++) {
  const s = G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, seed });
  const ids = allMoves(s).map(m => m.id);
  if (new Set(ids).size !== ids.length) dupes++;
}
ok("no session repeats a movement", dupes === 0, `${dupes}/50 had a dupe`);

console.log("\n== Conditioning focus skips heavy strength ==");
const cond = G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, focusOverride: "Conditioning", seed: 3 });
ok("conditioning has no Strength 1 block", !cond.blocks.some(b => b.name.startsWith("Strength 1")), cond.blocks.map(b=>b.name).join(" | "));

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
