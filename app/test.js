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
const swaps = G.swapCandidates(DATA, bsquat, { today, history: [], avoidList: [] });
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

console.log("\n== Warm-up is mobility, not loaded lifts; holds are time-based ==");
let loadedInWarmup = 0, warmups = 0;
for (let seed = 1; seed <= 40; seed++) {
  const s = G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, seed });
  const wu = s.blocks.find(b => b.name.startsWith("Warm")); warmups++;
  // non-cardio warm-up items must be unloaded mobility/bodyweight
  for (const it of wu.items) if (!it.movement.cardio && it.movement.loadable) loadedInWarmup++;
}
ok("no loaded lifts appear in the warm-up", loadedInWarmup === 0, `${loadedInWarmup} loaded items`);
// Plank prescribed by time, not reps
ok("plank warm-up prescription is time", /s|hold/.test(G.prescribe(movements.find(m=>m.id==="plank"), "warmup")), G.prescribe(movements.find(m=>m.id==="plank"),"warmup"));
ok("plank accessory prescription is a timed hold", /s/.test(G.prescribe(movements.find(m=>m.id==="plank"), "strength2")), G.prescribe(movements.find(m=>m.id==="plank"),"strength2"));
ok("squat reps prescription is rep-based", /x|×/.test(G.prescribe(movements.find(m=>m.id==="db-row"), "strength2")), G.prescribe(movements.find(m=>m.id==="db-row"),"strength2"));
ok("carry prescription is distance", /m/.test(G.prescribe(movements.find(m=>m.id==="farmers-carry"), "metcon")), G.prescribe(movements.find(m=>m.id==="farmers-carry"),"metcon"));

console.log("\n== Warm-up targets the day's regions ==");
let lowerHits = 0, lowerTrials = 0;
for (let seed = 1; seed <= 40; seed++) {
  const s = G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, focusOverride: "Squat & Pull", seed });
  const wu = s.blocks.find(b => b.name.startsWith("Warm"));
  lowerTrials++;
  if (wu.items.some(it => it.movement.region === "lower" || it.movement.region === "pull" || it.movement.region === "full")) lowerHits++;
}
ok("squat/pull day warm-up includes relevant-region mobility", lowerHits >= lowerTrials * 0.8, `${lowerHits}/${lowerTrials}`);

console.log("\n== Supersets share the SAME zone (honest label) most of the time ==");
let sameZone = 0, supTotal = 0, withinOne = 0, blockZoneHonest = 0, blockZoneTotal = 0;
for (const f of Object.keys(G.FOCUSES)) for (let seed = 1; seed <= 30; seed++) {
  const s = G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, focusOverride: f, seed });
  const sup = s.blocks.find(b => b.name.startsWith("Strength 2"));
  if (sup && sup.items.length === 2) {
    supTotal++;
    const d = G.pairZoneDistance(gym, sup.items[0].movement, sup.items[1].movement).dist;
    if (d === 0) sameZone++;
    if (d <= 1) withinOne++;
  }
  // Any block that carries a zone label: every item must actually include that zone.
  for (const b of s.blocks) {
    if (b.zone) { blockZoneTotal++; if (b.items.every(it => (it.movement.zones||[]).includes(b.zone))) blockZoneHonest++; }
  }
}
ok("every superset is within 1 zone (hard rule)", withinOne === supTotal, `${withinOne}/${supTotal}`);
// Same-zone is a soft preference (the hard rule is within-1); with cable/machine accessories in
// Zone C now in the pool, more pairs are adjacent rather than identical-zone, which is fine.
ok("supersets are at least often same-zone", sameZone >= supTotal * 0.5, `${sameZone}/${supTotal}`);
ok("a labeled block's zone is shared by all its moves (no false labels)", blockZoneHonest === blockZoneTotal, `${blockZoneHonest}/${blockZoneTotal}`);

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

console.log("\n== Prescriptive program: day archetypes ==");
const DAYS = Object.keys(G.PROGRAM_DAYS);
ok("7 program days defined", DAYS.length === 7, DAYS.join(", "));
let forbiddenViolations = 0, emptyBlockDays = 0, prepLoaded = 0, focusMismatch = 0, builtDays = 0;
for (const day of DAYS) {
  const cfg = G.PROGRAM_DAYS[day];
  for (let seed = 1; seed <= 25; seed++) {
    const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day, seed });
    builtDays++;
    if (s.focus !== day) focusMismatch++;
    if (!s.blocks.length) emptyBlockDays++;
    const allMv = s.blocks.flatMap(b => b.items.map(i => i.movement));
    // forbidden patterns must never appear
    for (const m of allMv) if ((cfg.forbidden || []).includes(m.pattern)) forbiddenViolations++;
    // prep block must be unloaded mobility/cardio
    const prep = s.blocks.find(b => b.role === "warmup");
    if (prep) for (const it of prep.items) if (!it.movement.cardio && it.movement.loadable) prepLoaded++;
  }
}
ok("program day is always honored", focusMismatch === 0, `${focusMismatch} mismatches`);
ok("no day produces an empty session", emptyBlockDays === 0, `${emptyBlockDays}`);
ok("forbidden patterns never appear in their day", forbiddenViolations === 0, `${forbiddenViolations} violations`);
ok("prep block has no loaded lifts", prepLoaded === 0, `${prepLoaded}`);

// Specific identity checks
function dayMoves(day, seed) { return G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day, seed }).blocks.flatMap(b => b.items.map(i => i.movement)); }
let pushHasLegs = 0, pullHasLegs = 0;
for (let seed = 1; seed <= 25; seed++) {
  if (dayMoves("Push Strength", seed).some(m => ["squat", "hinge", "lunge"].includes(m.pattern))) pushHasLegs++;
  if (dayMoves("Pull Strength", seed).some(m => ["squat", "hinge", "lunge"].includes(m.pattern))) pullHasLegs++;
}
ok("Push Strength never programs legs", pushHasLegs === 0, `${pushHasLegs}`);
ok("Pull Strength never programs legs", pullHasLegs === 0, `${pullHasLegs}`);
// Pump day uses isolation (arms/delts/calves) and stays easy
let pumpHeavy = 0;
for (let seed = 1; seed <= 25; seed++) {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Pump / Recovery", seed });
  if (s.blocks.some(b => b.intensity === "heavy")) pumpHeavy++;
}
ok("Pump / Recovery has no heavy blocks", pumpHeavy === 0, `${pumpHeavy}`);
// Upper Hypertrophy pulls in isolation movements that now exist
const ISO = ["biceps", "triceps", "side-delts", "rear-delts"];
const uh = dayMoves("Upper Hypertrophy", 3).map(m => m.pattern);
ok("Upper Hypertrophy includes arms/delts isolation", uh.some(p => ISO.includes(p)), uh.join(","));

console.log("\n== Accessory granularity: push gets triceps not biceps, pull gets biceps not triceps ==");
let pushBiceps = 0, pullTriceps = 0;
for (let seed = 1; seed <= 30; seed++) {
  const push = dayMoves("Push Strength", seed).map(m => m.pattern);
  const pull = dayMoves("Pull Strength", seed).map(m => m.pattern);
  if (push.includes("biceps")) pushBiceps++;
  if (pull.includes("triceps")) pullTriceps++;
}
ok("Push Strength never programs biceps", pushBiceps === 0, `${pushBiceps}`);
ok("Pull Strength never programs triceps", pullTriceps === 0, `${pullTriceps}`);

console.log("\n== Finisher block is implemented (Push day) ==");
let finisherSeen = 0;
for (let seed = 1; seed <= 40; seed++) {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed });
  const fin = s.blocks.find(b => b.role === "finisher");
  if (fin) { finisherSeen++; if (!fin.items.length) fail++; }
}
ok("optional finisher actually appears sometimes with content", finisherSeen > 0, `${finisherSeen}/40 seeds`);

console.log("\n== Load progression (working weight + RPE) ==");
const dbBench = movements.find(m => m.id === "db-bench");
const set = { bars: { him: "mens", her: "womens" } };
const up = G.loadSuggestion(dbBench, 8, {}, set, inv, { "db-bench": { him: { load: 50, rpe: 7, completed: true } } });
ok("RPE 7 (easy) suggests going up from 50", up.him.valueLb > 50, JSON.stringify(up.him));
const hold = G.loadSuggestion(dbBench, 8, {}, set, inv, { "db-bench": { him: { load: 50, rpe: 8, completed: true } } });
ok("RPE 8 holds at 50", hold.him.valueLb === 50, JSON.stringify(hold.him));
const down = G.loadSuggestion(dbBench, 8, {}, set, inv, { "db-bench": { him: { load: 50, rpe: 9, completed: false } } });
ok("missed reps suggests dropping below 50", down.him.valueLb < 50, JSON.stringify(down.him));
ok("suggestion shows the last weight reference", /last 50/.test(up.him.last || ""), up.him.last);
const enter = G.loadSuggestion(dbBench, 8, {}, set, inv, {});
ok("no history and no 1RM -> 'enter weight'", enter.him.display === "enter weight", enter.him.display);

console.log("\n== Program sequencer ==");
ok("6-day sequence has 6 days, 7-day has 7", G.programSequence(6).length === 6 && G.programSequence(7).length === 7);
ok("day 1 of a fresh program is Push Strength", G.nextProgramDay({ daysPerWeek: 6, logged: 0 }) === "Push Strength");
ok("after 2 logs, next is Day 3 Pull Strength", G.nextProgramDay({ daysPerWeek: 6, logged: 2 }) === "Pull Strength" && G.dayNumber({ daysPerWeek: 6, logged: 2 }) === 3);
ok("sequence wraps after a full week", G.dayNumber({ daysPerWeek: 6, logged: 6 }) === 1 && G.nextProgramDay({ daysPerWeek: 6, logged: 6 }) === "Push Strength");
ok("6-day program never schedules Pump/Recovery", Array.from({length: 18}, (_, i) => G.nextProgramDay({ daysPerWeek: 6, logged: i })).every(d => d !== "Pump / Recovery"));
ok("7-day program does schedule Pump/Recovery", Array.from({length: 7}, (_, i) => G.nextProgramDay({ daysPerWeek: 7, logged: i })).includes("Pump / Recovery"));

console.log("\n== Mesocycle wave ==");
ok("week 1 then 2 after one full cycle", G.mesocycleWeek({ daysPerWeek: 6, logged: 0 }) === 1 && G.mesocycleWeek({ daysPerWeek: 6, logged: 6 }) === 2);
ok("week 4 is the deload (after 3 cycles)", G.mesocycleWeek({ daysPerWeek: 6, logged: 18 }) === 4 && G.MESO[4].deload === true);
const wk4 = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", mesoWeek: 4, seed: 3 });
ok("deload main lift is light", /deload/i.test(wk4.blocks.find(b => b.role === "strength1").items[0].prescription));
ok("deload drops the optional finisher", !wk4.blocks.some(b => b.role === "finisher"));
const wk3 = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Upper Hypertrophy", mesoWeek: 3, seed: 3 });
const wk1 = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Upper Hypertrophy", mesoWeek: 1, seed: 3 });
const setsOf = (s) => s.blocks.filter(b => b.role !== "warmup").flatMap(b => b.items).reduce((n, it) => n + G.parseSets(it.prescription), 0);
ok("push week (3) has >= baseline (1) total sets", setsOf(wk3) >= setsOf(wk1), `wk3 ${setsOf(wk3)} vs wk1 ${setsOf(wk1)}`);

console.log("\n== Weekly volume readout ==");
ok("parseSets reads leading set count", G.parseSets("4×5 @ RPE 8") === 4 && G.parseSets("3×12–15") === 3 && G.parseSets("x8–10 (light)") === 0);
const phist = [G.sessionToHistoryEntry(Object.assign(G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", mesoWeek: 1, seed: 1 }), {}))];
phist[0].date = today;
const wv = G.weeklySets(phist, today);
ok("push day logs chest volume but no back volume", wv.sets.chest > 0 && wv.sets.back === 0, JSON.stringify(wv.sets));
ok("history items carry a set count", phist[0].items.some(it => it.sets > 0));
// Cardio exposure: a strength day's warm-up cardio should NOT count; a real conditioning day should.
ok("push day (warm-up cardio only) is not a cardio exposure", G.weeklySets(phist, today).cardioExposures === 0, `${G.weeklySets(phist, today).cardioExposures}`);
const condHist = [Object.assign(G.sessionToHistoryEntry(G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Conditioning + Core", seed: 2 })), { date: today })];
ok("a Conditioning + Core day counts as 1 cardio exposure", G.weeklySets(condHist, today).cardioExposures === 1, `${G.weeklySets(condHist, today).cardioExposures}`);
// Bucket de-dup: an RDL (hamstrings+glutes -> ham/glutes) at 3 sets counts as 3, not 6.
const rdlHist = [{ date: today, focus: "x", items: [{ movementId: "rdl-bb", pattern: "hinge", muscles: ["hamstrings", "glutes", "back"], intensity: "med", role: "strength2", sets: 3 }] }];
const rv = G.weeklySets(rdlHist, today);
ok("multi-muscle move counts its bucket once (no double count)", rv.sets["ham/glutes"] === 3, `ham/glutes=${rv.sets["ham/glutes"]}`);

console.log("\n== 12-week macrocycle ==");
ok("macro week 1 = Block 1 (Hypertrophy Base)", G.macrocycleWeek({ daysPerWeek: 6, logged: 0 }) === 1 && G.macroBlockKey({ daysPerWeek: 6, logged: 0 }) === "hypertrophy_base");
ok("week 5 = Block 2 (Strength-Biased)", G.macrocycleWeek({ daysPerWeek: 6, logged: 6 * 4 }) === 5 && G.macroBlockKey({ daysPerWeek: 6, logged: 6 * 4 }) === "strength_biased");
ok("week 9 = Block 3 (Fitness/Performance)", G.macrocycleWeek({ daysPerWeek: 6, logged: 6 * 8 }) === 9 && G.macroBlockKey({ daysPerWeek: 6, logged: 6 * 8 }) === "fitness_performance");
ok("week 13 wraps to week 1 / Block 1", G.macrocycleWeek({ daysPerWeek: 6, logged: 6 * 12 }) === 1 && G.macroBlockKey({ daysPerWeek: 6, logged: 6 * 12 }) === "hypertrophy_base");
// Block identity in the actual schemes: same day, different blocks -> different main rep targets.
const mainReps = (blk, wk) => {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", macroBlock: blk, mesoWeek: wk, seed: 5 });
  return s.blocks.find(b => b.role === "strength1").items[0].prescription;
};
ok("Block 1 main is rep-ish (8s)", /×8/.test(mainReps("hypertrophy_base", 1)), mainReps("hypertrophy_base", 1));
ok("Block 2 push week (wk3) main goes heavy (3s)", /×3/.test(mainReps("strength_biased", 3)), mainReps("strength_biased", 3));
ok("Block 3 main is moderate (6s)", /×6/.test(mainReps("fitness_performance", 1)), mainReps("fitness_performance", 1));
// Upper Hypertrophy must NOT become strength-biased in Block 2 (stays >=8 reps).
const uhMain = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Upper Hypertrophy", macroBlock: "strength_biased", mesoWeek: 3, seed: 5 }).blocks.find(b => b.name.indexOf("Superset") > -1).items[0].prescription;
ok("Upper Hypertrophy stays hypertrophy in Block 2 (no triples)", !/×[1-5] /.test(uhMain) && /×(8|10|12|15)/.test(uhMain), uhMain);
// Pump / Recovery stays easy in every block.
for (const blk of G.BLOCK_KEYS) {
  const pump = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Pump / Recovery", macroBlock: blk, mesoWeek: 3, seed: 5 });
  ok(`Pump stays easy in ${blk}`, pump.blocks.every(b => b.intensity !== "heavy" && b.intensity !== "med") || pump.blocks.filter(b=>b.role==="accessory").every(b=>/15–20/.test(b.items[0].prescription)), JSON.stringify(pump.blocks.map(b=>b.role)));
}
// Deload week (4) marks schemes and skips finisher. Use Block 1 here — Block 2 week 4 is the
// special test week (covered below), where the main lift is a 3RM test, not a labeled deload.
const dl = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", macroBlock: "hypertrophy_base", mesoWeek: 4, seed: 5 });
ok("deload schemes are labeled", /deload/i.test(dl.blocks.find(b => b.role === "strength1").items[0].prescription));
ok("deload skips finisher", !dl.blocks.some(b => b.role === "finisher"));

console.log("\n== Heavy-rep test week (Block 2, week 8) ==");
ok("isTestWeek only for strength_biased week 4", G.isTestWeek("strength_biased", 4) && !G.isTestWeek("strength_biased", 3) && !G.isTestWeek("hypertrophy_base", 4) && !G.isTestWeek("fitness_performance", 4));
// estimate1RM ≈ 3RM × 1.10 (doc example: 185×3 -> ~204).
ok("estimate1RM(185) ~ 204", G.estimate1RM(185) === 204, G.estimate1RM(185));
// Week 7 (strength_biased week 3) is the heavy-triple exposure week already (5×3 @ RPE 8-9).
ok("week 7 main = heavy triples (5×3 @ RPE 8-9)", /5×3 @ RPE 8-9/.test(mainReps("strength_biased", 3)), mainReps("strength_biased", 3));
// Week 8: strength-day main becomes an optional 3RM test, flagged for the 1RM update.
const tw = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", macroBlock: "strength_biased", mesoWeek: 4, seed: 5 });
const twMain = tw.blocks.find(b => b.role === "strength1").items[0];
ok("test-week main prescribes a 3RM", /3RM/.test(twMain.prescription), twMain.prescription);
ok("test-week main is flagged test=true", twMain.test === true);
ok("test-week safety phrasing present", /stop if form breaks/i.test(twMain.prescription));
ok("test-week still skips finisher (deload)", !tw.blocks.some(b => b.role === "finisher"));
// A hypertrophy day in the same week is NOT turned into a test.
const twHyp = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Upper Hypertrophy", macroBlock: "strength_biased", mesoWeek: 4, seed: 5 });
ok("hypertrophy day has no 3RM test in test week", !twHyp.blocks.flatMap(b => b.items).some(i => i.test));
// The test top set counts as one working set in the volume readout.
ok("3RM prescription parses to 1 working set", G.parseSets(G.TEST_MAIN_SCHEME) === 1, G.parseSets(G.TEST_MAIN_SCHEME));

console.log("\n== Slot-level stickiness ==");
// Main strength + accessory items carry a slotKey like "Push Strength::strength1::0".
const ps = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed: 4 });
const mainItem = ps.blocks.find(b => b.role === "strength1").items[0];
ok("main lift item has a slotKey", typeof mainItem.slotKey === "string" && mainItem.slotKey.indexOf("strength1") > -1, mainItem.slotKey);
// Forcing a slot reuses that movement next time (if it's a valid candidate).
const forced = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed: 4, slots: { "Push Strength::strength1::0": "db-bench" } });
ok("sticky slot reuses the recorded movement", forced.blocks.find(b => b.role === "strength1").items[0].movement.id === "db-bench", forced.blocks.find(b => b.role === "strength1").items[0].movement.id);
// Stickiness yields to validity: an avoided sticky movement is not forced.
const avoidedStick = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed: 4, slots: { "Push Strength::strength1::0": "db-bench" }, avoidList: ["db-bench"] });
ok("avoided sticky movement is not used", avoidedStick.blocks.find(b => b.role === "strength1").items[0].movement.id !== "db-bench");
// Slot keys are stable across regenerations of the same day.
const ps2 = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed: 9 });
ok("slot keys are stable for a day regardless of seed", ps2.blocks.find(b => b.role === "strength1").items[0].slotKey === mainItem.slotKey);

console.log("\n== Tracking types & per-set logging ==");
ok("loadable -> load_reps", G.trackingType({ loadable: true }) === "load_reps");
ok("unit time -> time", G.trackingType({ unit: "time" }) === "time");
ok("carry -> distance", G.trackingType({ pattern: "carry" }) === "distance");
ok("cardio -> cardio", G.trackingType({ cardio: true }) === "cardio");
ok("bodyweight -> reps", G.trackingType({}) === "reps");
// parse hold targets from prescriptions
ok("parse '3 × 45–60s' -> 60", G.parseTargetSeconds("3 × 45–60s") === 60, G.parseTargetSeconds("3 × 45–60s"));
ok("parse ':30–:45 hold' -> 45", G.parseTargetSeconds(":30–:45 hold") === 45, G.parseTargetSeconds(":30–:45 hold"));
ok("parse '30s hold' -> 30", G.parseTargetSeconds("30s hold") === 30, G.parseTargetSeconds("30s hold"));
ok("parse '4×8 @ RPE 8' -> null (no seconds)", G.parseTargetSeconds("4×8 @ RPE 8") === null, G.parseTargetSeconds("4×8 @ RPE 8"));
// repeatable working weight from a top-set/backoff
ok("repeatable [135,115,115] -> 115", G.repeatableLoad([{ load: 135 }, { load: 115 }, { load: 115 }]) === 115);
ok("repeatable single -> itself", G.repeatableLoad([{ load: 135 }]) === 135);
ok("repeatable tie -> lower", G.repeatableLoad([{ load: 100 }, { load: 105 }]) === 100);
// summarizePerf: top-set/backoff keeps top but suggests the repeatable weight
const sp = G.summarizePerf({ trackingType: "load_reps", status: "done", rpe: 8, anyEntered: true, sets: [{ load: 135, reps: 20 }, { load: 115, reps: 20 }, { load: 115, reps: 20 }] });
ok("summarize top = 135", sp.top === 135, JSON.stringify(sp));
ok("summarize repeatable load = 115", sp.load === 115, JSON.stringify(sp));
ok("summarize source measured when entered", sp.source === "measured");
const spA = G.summarizePerf({ trackingType: "load_reps", status: "done", anyEntered: false, sets: [{ load: 100 }] });
ok("summarize source assumed when blank", spA.source === "assumed");
const spT = G.summarizePerf({ trackingType: "time", status: "partial", seconds: 45, targetSeconds: 60, anyEntered: true });
ok("summarize time keeps seconds/target", spT.seconds === 45 && spT.targetSeconds === 60 && spT.completed === true);
const spS = G.summarizePerf({ trackingType: "load_reps", status: "skipped", anyEntered: true, sets: [] });
ok("summarize skipped -> completed false", spS.completed === false && spS.status === "skipped");

console.log("\n== Progression respects status & source ==");
ok("skipped -> no change", G.progressDir({ status: "skipped" }) === 0);
ok("partial -> back off", G.progressDir({ status: "partial" }) === -1);
ok("assumed done holds even at low RPE", G.progressDir({ status: "done", source: "assumed", rpe: 6 }) === 0);
ok("measured RPE7 -> up", G.progressDir({ status: "done", source: "measured", rpe: 7 }) === 1);
ok("measured RPE10 -> down", G.progressDir({ status: "done", source: "measured", rpe: 10 }) === -1);
ok("measured blank RPE -> hold", G.progressDir({ status: "done", source: "measured", rpe: null }) === 0);
// backward compatibility with old {completed, rpe} records
ok("legacy completed+RPE7 -> up", G.progressDir({ completed: true, rpe: 7 }) === 1);
ok("legacy missed -> down", G.progressDir({ completed: false }) === -1);

console.log("\n== Timed-hold suggestion ==");
const plank = { id: "plank" };
ok("no history -> target", G.holdSuggestion(plank, 60, {}).him.seconds === 60);
ok("missed hold backs off to held time", G.holdSuggestion(plank, 60, { plank: { him: { seconds: 45, targetSeconds: 60, status: "partial" } } }).him.seconds === 45);
ok("hit target -> small bump", G.holdSuggestion(plank, 60, { plank: { him: { seconds: 60, targetSeconds: 60, status: "done" } } }).him.seconds === 65);

console.log("\n== Movement log summary (progress screen) ==");
const lrEntries = [{ trackingType: "load_reps", top: 135, load: 115, date: "2026-06-10" }, { trackingType: "load_reps", top: 130, load: 130, date: "2026-06-03" }];
const lrS = G.summarizeMovementLogs(lrEntries);
ok("last = newest entry", lrS.last.date === "2026-06-10");
ok("best = heaviest top across entries", lrS.best.load === 135, JSON.stringify(lrS.best));
ok("session count", lrS.sessions === 2);
const tS = G.summarizeMovementLogs([{ trackingType: "time", seconds: 50, date: "2026-06-10" }, { trackingType: "time", seconds: 60, date: "2026-06-03" }]);
ok("best hold = longest seconds", tS.best.seconds === 60);

console.log("\n== Movement library cleanup ==");
// Program mode never surfaces non-default (CrossFit/Olympic/specialty) movements across all days/seeds.
const NON_DEFAULT = new Set(movements.filter(m => m.programDefault === false).map(m => m.id));
ok("excluded set is non-empty", NON_DEFAULT.size >= 15);
ok("bench/box dip program-eligible; parallel dips opt-in", !NON_DEFAULT.has("bench-box-dip") && NON_DEFAULT.has("tricep-dips"));
let leaked = null;
for (const day of Object.keys(G.PROGRAM_DAYS)) {
  for (let seed = 1; seed <= 40 && !leaked; seed++) {
    const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day, seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
    for (const m of allMoves(s)) if (NON_DEFAULT.has(m.id)) { leaked = `${day}/${seed}: ${m.id}`; break; }
  }
}
ok("no non-default movement leaks into any program day", leaked === null, leaked);
// Freestyle keeps the full pool — a non-default movement is still eligible there.
let freestyleHasNonDefault = false;
for (let seed = 1; seed <= 60 && !freestyleHasNonDefault; seed++) {
  const s = G.buildSession(DATA, { today, history: [], maxes: {}, settings: {}, seed });
  if (allMoves(s).some(m => NON_DEFAULT.has(m.id))) freestyleHasNonDefault = true;
}
ok("freestyle can still use non-default movements", freestyleHasNonDefault);
// Specific leaks the user reported are gone from Push Strength.
let pushHadBadPress = false;
for (let seed = 1; seed <= 40; seed++) {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  if (allMoves(s).some(m => ["kb-push-press", "push-press-bb", "db-push-press"].includes(m.id))) pushHadBadPress = true;
}
ok("Push Strength never picks push-press / jerk variants", !pushHadBadPress);
ok("floor press removed from library entirely", !movements.some(m => m.id === "floor-press-bb"));

console.log("\n== Accessory supersets avoid duplicate-pattern pairs ==");
let dupTriceps = false;
for (let seed = 1; seed <= 60; seed++) {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  const sup = s.blocks.find(b => /superset/i.test(b.name));
  if (sup && sup.items.length === 2 && sup.items[0].movement.pattern === sup.items[1].movement.pattern) dupTriceps = true;
}
ok("Push accessory superset never pairs same pattern (no triceps+triceps)", !dupTriceps);

console.log("\n== Warm-up wording is type-aware (no '(light)' on bodyweight) ==");
ok("mobility warmup -> controlled reps", G.prescribe({ pattern: "mobility", loadable: false }, "warmup", () => 0.5) === "8–10 controlled reps");
ok("bodyweight warmup -> easy reps", G.prescribe({ pattern: "h-push", loadable: false }, "warmup", () => 0.5) === "8–10 easy reps");
ok("unilateral mobility warmup adds /side", G.prescribe({ pattern: "mobility", loadable: false, unilateral: true }, "warmup", () => 0.5) === "8–10 controlled reps/side");
ok("loaded warmup ramp -> light reps", G.prescribe({ pattern: "squat", loadable: true }, "warmup", () => 0.5) === "8–10 light reps");
ok("no warmup prescription says '(light)'", !/\(light\)/.test(G.prescribe({ pattern: "mobility", loadable: false }, "warmup", () => 0.5)));

console.log("\n== Tier system (core preferred over secondary) ==");
ok("tierBonus core > secondary; default == secondary", G.tierBonus({ tier: "core" }) > G.tierBonus({ tier: "secondary" }) && G.tierBonus({}) === G.tierBonus({ tier: "secondary" }));
// Behaviorally: the hinge main (where core RDLs compete with untagged deadlift/glute-bridge variants)
// is a core-tier movement the majority of the time.
let hingeCore = 0, hingeTot = 0;
for (let seed = 1; seed <= 60; seed++) {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Lower Hypertrophy — Hinge", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  const main = s.blocks.find(b => b.role === "strength1");
  if (main) { hingeTot++; const mv = movements.find(x => x.id === main.items[0].movement.id); if (mv.tier === "core") hingeCore++; }
}
ok("hinge main is core-tier most of the time", hingeCore >= hingeTot * 0.6, `${hingeCore}/${hingeTot}`);

console.log("\n== New conventional movements ==");
ok("glutes pattern maps to lower region", G.PATTERN_REGION.glutes === "lower");
for (const id of ["incline-bench-bb", "machine-pec-deck", "cable-row", "assisted-pullup-machine", "hack-squat", "cable-lateral-raise", "reverse-pec-deck", "hip-abduction-machine", "cable-crunch", "dead-bug", "v-up-single-leg"]) {
  ok(`added: ${id}`, movements.some(m => m.id === id));
}
// Hack squat (squat main) can surface in Lower Strength; hip abduction (glutes) in a lower day.
let sawHack = false, sawAbd = false;
for (let seed = 1; seed <= 60; seed++) {
  const ls = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Lower Strength — Squat", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  if (allMoves(ls).some(m => m.id === "hack-squat")) sawHack = true;
  const lh = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Lower Hypertrophy — Hinge", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  if (allMoves(lh).some(m => m.id === "hip-abduction-machine")) sawAbd = true;
}
ok("hack squat can be selected in Lower Strength", sawHack);
ok("hip abduction (glutes) can be selected on a lower day", sawAbd);

console.log("\n== Downgrades & core splits ==");
// KB swing lost its strength role -> never appears in a program session.
let sawSwing = false;
for (const day of Object.keys(G.PROGRAM_DAYS)) for (let seed = 1; seed <= 25; seed++) {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day, seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  if (allMoves(s).some(m => m.id === "kb-swing")) sawSwing = true;
}
ok("KB swing never appears in program (metcon-only now)", !sawSwing);
const rt = movements.find(m => m.id === "russian-twist");
ok("Russian Twist is a loadable med-ball move", rt.loadable === true && rt.implement === "medball");
const lc = movements.find(m => m.id === "leg-curl");
ok("Leg Curl renamed to Seated Leg Curl", lc.name === "Seated Leg Curl");
ok("Sumo deadlift is rare (frequency-capped)", movements.find(m => m.id === "sumo-deadlift-bb").frequencyCapPerWeeks > 0);

console.log("\n== Warm-up matches the day's body regions ==");
let warmMismatch = null;
for (const day of Object.keys(G.PROGRAM_DAYS)) {
  const cfg = G.PROGRAM_DAYS[day];
  const tr = new Set([...(cfg.primary || []), ...(cfg.secondary || [])].map(p => G.PATTERN_REGION[p]).filter(Boolean));
  for (let seed = 1; seed <= 30 && !warmMismatch; seed++) {
    const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day, seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
    const warm = s.blocks.find(b => b.role === "warmup");
    if (!warm) continue;
    for (const it of warm.items) {
      const mv = it.movement;
      if (mv.cardio) continue; // the general cardio piece is allowed regardless
      if (!(tr.has(mv.region) || mv.region === "full")) { warmMismatch = `${day}/${seed}: ${mv.id} (${mv.region}) not in [${[...tr]}]`; break; }
    }
  }
}
ok("every warm-up mobility matches the day's regions (or full)", warmMismatch === null, warmMismatch);
// The reported case: no hip/lower mobility (90/90, leg swings) before a Push session.
let lowerOnPush = false;
for (let seed = 1; seed <= 40; seed++) {
  const s = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  const warm = s.blocks.find(b => b.role === "warmup");
  if (warm && warm.items.some(it => !it.movement.cardio && it.movement.region === "lower")) lowerOnPush = true;
}
ok("no lower-body mobility in a Push warm-up", !lowerOnPush);

console.log("\n== Busy-day crowd avoidance ==");
const crowd = gym.crowd;
ok("crowd model present (busyDays + crowdedZones)", crowd && crowd.busyDays.length > 0 && crowd.crowdedZones.length > 0);
ok("isBusyDay: Mon busy, Thu not", G.isBusyDay("Mon", crowd) && !G.isBusyDay("Thu", crowd));
ok("stuckInCrowd: bench (A-only) yes, db-shoulder-press (A,E) no, squat (B) no",
  G.stuckInCrowd(movements.find(m => m.id === "bench-press-bb"), crowd) &&
  !G.stuckInCrowd(movements.find(m => m.id === "db-shoulder-press"), crowd) &&
  !G.stuckInCrowd(movements.find(m => m.id === "back-squat-bb"), crowd));
ok("crowdPenalty only applies on busy days", G.crowdPenalty(movements.find(m => m.id === "bench-press-bb"), true, crowd) > 0 && G.crowdPenalty(movements.find(m => m.id === "bench-press-bb"), false, crowd) === 0);
// Behavior: on a busy weekday the Push main avoids Zone-A-only lifts (bench/DB), preferring the
// rig overhead press (B) or machine press (C). On a quiet day the bench is free to appear.
const MON = "2026-06-15", THU = "2026-06-18"; // 06-14 is Sunday
let busyCrowdedMain = 0, quietCrowdedMain = 0;
for (let seed = 1; seed <= 40; seed++) {
  const mon = G.buildProgramSession(DATA, { today: MON, history: [], maxes: {}, settings: {}, day: "Push Strength", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  if (G.stuckInCrowd(mon.blocks.find(b => b.role === "strength1").items[0].movement, crowd)) busyCrowdedMain++;
  const thu = G.buildProgramSession(DATA, { today: THU, history: [], maxes: {}, settings: {}, day: "Push Strength", seed, macroBlock: "hypertrophy_base", mesoWeek: 1 });
  if (G.stuckInCrowd(thu.blocks.find(b => b.role === "strength1").items[0].movement, crowd)) quietCrowdedMain++;
}
ok("busy-day Push main avoids the crowded bench/DB zone", busyCrowdedMain === 0, `${busyCrowdedMain}/40`);
ok("quiet-day Push main still uses the bench sometimes", quietCrowdedMain > 0, `${quietCrowdedMain}/40`);

console.log("\n== No similar body parts two days in a row (smart next-day) ==");
ok("day regions: Push=push, Conditioning/Pump=empty",
  G.dayMuscleRegions(G.PROGRAM_DAYS["Push Strength"]).has("push") &&
  G.dayMuscleRegions(G.PROGRAM_DAYS["Conditioning + Core"]).size === 0 &&
  G.dayMuscleRegions(G.PROGRAM_DAYS["Pump / Recovery"]).size === 0);
// A logged session's blocking regions come from heavy/med work only (pump/light doesn't block).
const yPush = { date: "2026-06-14", items: [{ pattern: "h-push", intensity: "heavy", muscles: ["chest"] }] };
const yLower = { date: "2026-06-14", items: [{ pattern: "squat", intensity: "heavy", muscles: ["quads"] }] };
const yPump = { date: "2026-06-14", items: [{ pattern: "triceps", intensity: "light", muscles: ["triceps"] }, { pattern: "side-delts", intensity: "light", muscles: ["delts"] }] };
ok("session regions from heavy/med work", G.sessionMuscleRegions(yPush).has("push") && G.sessionMuscleRegions(yPump).size === 0);
const T = "2026-06-15"; // day after 06-14
// Positional next after a fresh program is Push; if Push was trained yesterday, skip to Lower.
ok("Push yesterday -> next skips Push to Lower Squat",
  G.nextProgramDay({ daysPerWeek: 6, logged: 0 }, [yPush], T) === "Lower Strength — Squat");
// Upper Hypertrophy (push+pull) is also skipped after a push day.
ok("Push yesterday -> Upper Hypertrophy positional is skipped",
  G.nextProgramDay({ daysPerWeek: 6, logged: 4 }, [yPush], T) !== "Upper Hypertrophy");
// No overlap -> sequence is unchanged (Lower yesterday, positional Push stays Push).
ok("Lower yesterday -> next stays Push", G.nextProgramDay({ daysPerWeek: 6, logged: 0 }, [yLower], T) === "Push Strength");
// A light Pump day doesn't block the next day.
ok("Pump yesterday doesn't block Push", G.nextProgramDay({ daysPerWeek: 6, logged: 0 }, [yPump], T) === "Push Strength");
// Guard only applies to a recent session (yesterday/today), not an old one.
ok("old session (3 days ago) doesn't reorder", G.nextProgramDay({ daysPerWeek: 6, logged: 0 }, [{ date: "2026-06-12", items: yPush.items }], T) === "Push Strength");
// Back-compat: called without history/today, behaves positionally.
ok("no-history call is positional", G.nextProgramDay({ daysPerWeek: 6, logged: 0 }) === "Push Strength");

console.log("\n== Workload meter ==");
const wkSession = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Push Strength", seed: 3, macroBlock: "hypertrophy_base", mesoWeek: 1 });
const wl = G.sessionWorkload(wkSession);
ok("workload counts working sets (>0)", wl.sets > 0, JSON.stringify(wl));
ok("light session reads ok", G.sessionWorkload({ blocks: [{ items: [{ prescription: "3×10" }, { prescription: "3×12" }] }] }).level === "ok");
ok("piled-on session reads over", G.sessionWorkload({ blocks: [{ items: Array.from({ length: 11 }, () => ({ prescription: "3×12" })) }] }).level === "over");
ok("warm-ups/cardio don't add volume", G.sessionWorkload({ blocks: [{ items: [{ prescription: "8–10 easy reps" }, { prescription: "AMRAP 12 min" }, { prescription: "30s hold" }] }] }).sets === 0);

console.log("\n== Share encode/decode round-trip ==");
const shareSrc = G.buildProgramSession(DATA, { today, history: [], maxes: {}, settings: {}, day: "Pull Strength", seed: 8, macroBlock: "strength_biased", mesoWeek: 2 });
const codeStr = G.encodeSession(shareSrc);
ok("encode produces a url-safe string", typeof codeStr === "string" && /^[A-Za-z0-9_-]+$/.test(codeStr), codeStr.slice(0, 24) + "…");
const decoded = G.decodeSession(codeStr, movements);
const srcIds = shareSrc.blocks.flatMap(b => b.items.map(i => i.movement.id));
const decIds = decoded.blocks.flatMap(b => b.items.map(i => i.movement.id));
ok("decode restores the same movements in order", JSON.stringify(srcIds) === JSON.stringify(decIds), `${srcIds.length} vs ${decIds.length}`);
const srcPresc = shareSrc.blocks.flatMap(b => b.items.map(i => i.prescription));
const decPresc = decoded.blocks.flatMap(b => b.items.map(i => i.prescription));
ok("decode restores prescriptions (dictionary)", JSON.stringify(srcPresc) === JSON.stringify(decPresc));
ok("decode carries focus + mode", decoded.focus === shareSrc.focus && decoded.mode === "program" && decoded.shared === true);
ok("decode drops unknown movement ids gracefully", (() => {
  const tampered = G.decodeSession(codeStr, movements.filter(m => m.id !== decIds[0]));
  return tampered.blocks.flatMap(b => b.items).every(i => i.movement.id !== decIds[0]);
})());
ok("share omits loads (weights stay personal)", decoded.blocks.every(b => b.items.every(i => i.load === undefined)));

console.log("\n== Dumbbells available in Zone B (except bench moves) ==");
const dbMoves = movements.filter(m => m.implement === "dumbbell");
ok("dumbbell moves can be done in Zone B (except bench-based ones)", dbMoves.filter(m => !(m.zones || []).includes("B")).every(m => ["db-bench", "db-incline-bench", "db-fly", "spider-curl", "db-pullover", "seated-db-curl"].includes(m.id)), dbMoves.filter(m => !(m.zones || []).includes("B")).map(m => m.id).join(", "));
ok("bench-requiring DB moves stay out of Zone B", ["db-bench", "db-incline-bench", "db-fly"].every(id => !(movements.find(m => m.id === id).zones || []).includes("B")));
ok("nothing is named 'Echo' anymore", movements.every(m => !/Echo/i.test(m.name)));

console.log("\n== PHAT fixed template ==");
ok("5 PHAT days defined (Day 3 is rest)", Object.keys(G.PHAT_DAYS).length === 5);
const phatAll = Object.keys(G.PHAT_DAYS).flatMap(d => G.PHAT_DAYS[d].blocks.flatMap(b => b.items.map(i => i.id)));
const mvIds = new Set(movements.map(m => m.id));
ok("every PHAT exercise resolves to a real movement", phatAll.every(id => mvIds.has(id)), phatAll.filter(id => !mvIds.has(id)).join(", "));
const phat = G.buildPhatSession(DATA, { today, maxes: {}, settings: {}, progress: {}, slots: {}, day: "PHAT — Upper Power" });
ok("PHAT session mode is phat", phat.mode === "phat");
ok("PHAT is set in stone: power row is Pendlay 3×3–5", phat.blocks[0].items[0].movement.id === "pendlay-row-bb" && phat.blocks[0].items[0].prescription === "3×3–5");
// Deterministic — no seed variance.
const phat2 = G.buildPhatSession(DATA, { today, maxes: {}, settings: {}, progress: {}, slots: {}, day: "PHAT — Upper Power", seed: 999 });
ok("PHAT is deterministic (same movements regardless of seed)",
  JSON.stringify(phat.blocks.flatMap(b => b.items.map(i => i.movement.id))) === JSON.stringify(phat2.blocks.flatMap(b => b.items.map(i => i.movement.id))));
// Machine/weighted-bodyweight items still get a weight field; pure bodyweight (rack chin) doesn't.
const lowH = G.buildPhatSession(DATA, { today, maxes: {}, settings: {}, progress: {}, slots: {}, day: "PHAT — Lower Hypertrophy" });
const hack = lowH.blocks.flatMap(b => b.items).find(i => i.movement.id === "hack-squat");
ok("machine PHAT item gets a weight field (loadable forced)", hack && hack.load && hack.weighted === true);
const rackChin = phat.blocks.flatMap(b => b.items).find(i => i.movement.id === "rack-chin");
ok("bodyweight PHAT item has no weight field", rackChin && rackChin.load === null && rackChin.weighted === false);
// A logged swap sticks (set in stone otherwise).
const swapped = G.buildPhatSession(DATA, { today, maxes: {}, settings: {}, progress: {}, slots: { "phat::PHAT — Upper Power::0::0": "bent-row-bb" }, day: "PHAT — Upper Power" });
ok("a swapped PHAT slot sticks via slots", swapped.blocks[0].items[0].movement.id === "bent-row-bb");
// PHAT movements stay out of the dynamic program.
ok("PHAT-only movements are programDefault:false", ["weighted-pull-up", "rack-chin", "ez-bar-curl", "preacher-curl", "lying-leg-curl"].every(id => movements.find(m => m.id === id).programDefault === false));
// PHAT shares like any session (plan round-trips).
const phatCode = G.encodeSession(phat);
const phatDecoded = G.decodeSession(phatCode, movements);
ok("PHAT session round-trips through share encode/decode", phatDecoded.mode === "phat" && phatDecoded.blocks[0].items[0].movement.id === "pendlay-row-bb");

console.log("\n== Arnold Volume fixed template ==");
ok("5 Arnold days defined (3 in V1, 2 in V2)", Object.keys(G.ARNOLD_DAYS).length === 5);
ok("two variations present", Object.values(G.ARNOLD_DAYS).filter(d => d.variation === 1).length === 3 && Object.values(G.ARNOLD_DAYS).filter(d => d.variation === 2).length === 2);
const arnAll = Object.keys(G.ARNOLD_DAYS).flatMap(d => G.ARNOLD_DAYS[d].blocks.flatMap(b => b.items.map(i => i.id)));
ok("every Arnold exercise resolves to a real movement", arnAll.every(id => mvIds.has(id)), arnAll.filter(id => !mvIds.has(id)).join(", "));
const arn = G.buildArnoldSession(DATA, { today, maxes: {}, settings: {}, progress: {}, slots: {}, day: "Arnold V2 — Chest, Back & Legs" });
ok("Arnold session mode is arnold", arn.mode === "arnold");
ok("isFixedMode treats arnold as fixed", G.isFixedMode("arnold") && G.isFixedMode("phat") && !G.isFixedMode("program"));
ok("Arnold is set in stone: V2 chest opens with Bench 5×6–10", arn.blocks[0].items[0].movement.id === "bench-press-bb" && arn.blocks[0].items[0].prescription === "5 × 6–10");
// Deterministic regardless of seed.
const arn2 = G.buildArnoldSession(DATA, { today, maxes: {}, settings: {}, progress: {}, slots: {}, day: "Arnold V2 — Chest, Back & Legs", seed: 42 });
ok("Arnold is deterministic (same movements regardless of seed)",
  JSON.stringify(arn.blocks.flatMap(b => b.items.map(i => i.movement.id))) === JSON.stringify(arn2.blocks.flatMap(b => b.items.map(i => i.movement.id))));
// Machine items (leg press) get a weight field; bodyweight (dips, abs circuit) don't.
const legPress = arn.blocks.flatMap(b => b.items).find(i => i.movement.id === "leg-press");
ok("machine Arnold item gets a weight field (loadable forced)", legPress && legPress.load && legPress.weighted === true);
const arnDips = arn.blocks.flatMap(b => b.items).find(i => i.movement.id === "tricep-dips");
ok("bodyweight Arnold item has no weight field", arnDips && arnDips.load === null && arnDips.weighted === false);
// A logged swap sticks.
const arnSwap = G.buildArnoldSession(DATA, { today, maxes: {}, settings: {}, progress: {}, slots: { "arnold::Arnold V2 — Chest, Back & Legs::1::1": "bent-row-bb" }, day: "Arnold V2 — Chest, Back & Legs" });
ok("a swapped Arnold slot sticks via slots", arnSwap.blocks[1].items[1].movement.id === "bent-row-bb");
// Arnold-specific movements stay out of the dynamic program.
ok("Arnold-only movements are programDefault:false", ["db-pullover", "t-bar-row", "barbell-curl", "wrist-curl", "abs-circuit", "clean-and-press-bb"].every(id => movements.find(m => m.id === id).programDefault === false));
// Round-trips through share like any session.
const arnDecoded = G.decodeSession(G.encodeSession(arn), movements);
ok("Arnold session round-trips through share encode/decode", arnDecoded.mode === "arnold" && arnDecoded.blocks[0].items[0].movement.id === "bench-press-bb");
// Set ranges parse to the upper bound for the volume meter.
ok("set-range prescription parses (3–4 × 10 → 4 sets)", G.parseSets("3–4 × 10") === 4 && G.parseSets("4×5") === 4 && G.parseSets("3×3–5") === 3);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
