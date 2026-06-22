/*
 * Workout generator — pure logic + browser UI.
 *
 * The top half is dependency-free logic (no DOM, no fetch) so it can be unit-tested
 * in Node. The bottom half (guarded by `typeof document`) loads data, wires the UI,
 * and persists state to localStorage.
 */

// ----------------------------------------------------------------------------
// Constants & small helpers
// ----------------------------------------------------------------------------

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const INTENSITY_WEIGHT = { heavy: 1.0, med: 0.6, light: 0.3 };
const ROLE_INTENSITY = { strength1: "heavy", strength2: "med", metcon: "light", warmup: "light", core: "light", skill: "light" };

// Recovery window (days) over which a trained pattern's fatigue decays to zero.
const PATTERN_WINDOW = { core: 2, conditioning: 2, _default: 3 };

// Coarse body region each pattern trains — used to warm up the right areas.
const PATTERN_REGION = {
  squat: "lower", hinge: "lower", lunge: "lower", glutes: "lower",
  "h-push": "push", "v-push": "push", "h-pull": "pull", "v-pull": "pull",
  olympic: "full", carry: "full", core: "core", conditioning: "cardio", mobility: "full",
  biceps: "pull", triceps: "push", "side-delts": "push", "rear-delts": "pull", calves: "lower",
};

// Movement-quality tier → Program selection bonus. "core" lifts (the boring, repeatable,
// progressable staples) get a selection boost so they're preferred over "secondary"/untagged
// variations. (Specialty/CrossFit moves are gated out earlier via programDefault, so within the
// program pool the meaningful distinction is core vs. everything-else.)
const TIER_BONUS = { core: 1.0, secondary: 0 };
function tierBonus(m) { return TIER_BONUS[m.tier] != null ? TIER_BONUS[m.tier] : 0; }

// Crowd avoidance: on busy weekdays, steer away from movements that can ONLY be done in a
// crowded zone (the bench/DB end). A movement with an alternative zone isn't penalized — you
// just do it in the open spot. The penalty is large enough to effectively exclude crowded-only
// movements whenever an alternative exists (bench → rig overhead press or machine press), while
// pickWeighted's floor still lets one through if EVERY candidate is crowded-only.
const CROWD_PENALTY = 5;
function isBusyDay(dow, crowd) { return !!(crowd && crowd.busyDays && crowd.busyDays.includes(dow)); }
function stuckInCrowd(m, crowd) {
  const cz = (crowd && crowd.crowdedZones) || [];
  const zs = m.zones || [];
  return zs.length > 0 && zs.every((z) => cz.includes(z));
}
function crowdPenalty(m, busyToday, crowd) { return busyToday && stuckInCrowd(m, crowd) ? CROWD_PENALTY : 0; }

// Which body regions a focus's session will train (so the warm-up can target them).
function computeTargetRegions(cfg) {
  const pats = [].concat(cfg.s1 || [], cfg.s2a || [], cfg.s2b || [], cfg.metconOnly ? cfg.metcon : []);
  return new Set(pats.map((p) => PATTERN_REGION[p]).filter(Boolean));
}

// Unit-aware prescription text. slot ∈ warmup | strength1 | strength2 | metcon.
function prescribe(m, slot, rng) {
  const r = rng || (() => 0.5);
  if (m.cardio) return slot === "warmup" ? "1–2 min easy" : ["10–15 cal", "200–250 m", "60–90s"][Math.floor(r() * 3)];
  const u = m.unit || "reps";
  if (u === "time") {
    if (slot === "warmup") return "30s hold";
    if (slot === "strength2") return "3 × 45–60s";
    return ":30–:45 hold";
  }
  if (u === "distance") {
    if (slot === "warmup") return "1 length";
    if (slot === "strength2") return "3 × 20–30 m";
    return "30–40 m";
  }
  if (slot === "warmup") {
    const side = m.unilateral ? "/side" : "";
    if (!m.loadable) return (m.pattern === "mobility" ? "8–10 controlled reps" : "8–10 easy reps") + side;
    return "8–10 light reps" + side; // a loaded ramp set actually warrants "light"
  }
  if (slot === "strength2") return m.pattern === "core" ? "3×12–15" : "3×10 @ RPE 8";
  return "x" + [8, 10, 12, 15][Math.floor(r() * 4)];
}

// Focus templates: which patterns each focus loads, in which slot.
const FOCUSES = {
  "Squat & Pull": { s1: ["squat"], s2a: ["v-pull", "h-pull"], s2b: ["lunge", "core"], metcon: ["hinge", "conditioning", "core"] },
  "Hinge & Press": { s1: ["hinge"], s2a: ["h-push", "v-push"], s2b: ["core", "carry"], metcon: ["squat", "conditioning", "core"] },
  "Full Body": { s1: ["squat", "hinge", "lunge", "olympic"], s2a: ["h-push", "v-push", "h-pull", "v-pull"], s2b: ["lunge", "core", "carry"], metcon: ["conditioning", "core", "olympic"] },
  "OLY & Skill": { s1: ["olympic"], s2a: ["v-pull", "core"], s2b: ["core", "conditioning"], metcon: ["conditioning", "olympic", "core"] },
  "Conditioning": { metconOnly: true, metcon: ["conditioning", "olympic", "lunge", "hinge", "core"] },
};

// Approx %1RM for a given rep target (used to turn est-1RM into a working weight).
function pctForReps(reps) {
  const table = { 1: 1.0, 2: 0.95, 3: 0.9, 4: 0.88, 5: 0.85, 6: 0.82, 8: 0.75, 10: 0.7, 12: 0.67, 15: 0.62 };
  if (table[reps]) return table[reps];
  // Epley-ish interpolation for anything not in the table.
  return Math.max(0.55, 1 / (1 + reps / 30));
}

function daysBetween(a, b) {
  const MS = 86400000;
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / MS);
}

// Seedable RNG (mulberry32) so generation is varied but reproducible in tests.
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(items, weightFn, rng) {
  const weights = items.map((it) => Math.max(0.0001, weightFn(it)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ----------------------------------------------------------------------------
// Freshness scoring
// ----------------------------------------------------------------------------

// Returns { pattern: fatigue } and { muscle: fatigue } over the last 7 days.
// Lower fatigue = fresher.
function computeFatigue(history, today) {
  const patternFatigue = {};
  const muscleFatigue = {};
  for (const session of history) {
    const ago = daysBetween(session.date, today);
    if (ago < 0 || ago > 7) continue;
    for (const item of session.items || []) {
      const win = PATTERN_WINDOW[item.pattern] || PATTERN_WINDOW._default;
      const decay = Math.max(0, 1 - ago / win);
      if (decay <= 0) continue;
      const w = (INTENSITY_WEIGHT[item.intensity] || 0.3) * decay;
      patternFatigue[item.pattern] = (patternFatigue[item.pattern] || 0) + w;
      for (const m of item.muscles || []) {
        muscleFatigue[m] = (muscleFatigue[m] || 0) + w;
      }
    }
  }
  return { patternFatigue, muscleFatigue };
}

function freshness(pattern, patternFatigue) {
  return 1 / (1 + (patternFatigue[pattern] || 0));
}

// Rolling-week counts for the push:pull and squat:hinge balance nudge.
function balanceBias(history, today) {
  const c = { "h-push": 0, "v-push": 0, "h-pull": 0, "v-pull": 0, squat: 0, hinge: 0 };
  for (const session of history) {
    const ago = daysBetween(session.date, today);
    if (ago < 0 || ago > 7) continue;
    for (const item of session.items || []) {
      if (c[item.pattern] !== undefined) c[item.pattern] += INTENSITY_WEIGHT[item.intensity] || 0.3;
    }
  }
  const push = c["h-push"] + c["v-push"];
  const pull = c["h-pull"] + c["v-pull"];
  return {
    pushBias: pull - push, // >0 means we owe pushing
    pullBias: push - pull,
    squatBias: c.hinge - c.squat,
    hingeBias: c.squat - c.hinge,
    counts: c,
  };
}

// ----------------------------------------------------------------------------
// Candidate filtering (scheduling rules)
// ----------------------------------------------------------------------------

function lastUsed(history, movementId, today) {
  let best = null;
  for (const session of history) {
    for (const item of session.items || []) {
      if (item.movementId === movementId) {
        const ago = daysBetween(session.date, today);
        if (best === null || ago < best) best = ago;
      }
    }
  }
  return best;
}

function filterCandidates(movements, ctx) {
  const todayDow = DOW[new Date(ctx.today + "T00:00:00").getDay()];
  return movements.filter((m) => {
    if (ctx.avoidList && ctx.avoidList.includes(m.id)) return false;
    if (m.preferredDays && !m.preferredDays.includes(todayDow)) return false;
    if (m.frequencyCapPerWeeks) {
      const lu = lastUsed(ctx.history, m.id, ctx.today);
      if (lu !== null && lu < m.frequencyCapPerWeeks * 7) return false;
    }
    return true;
  });
}

// ----------------------------------------------------------------------------
// Zone helpers
// ----------------------------------------------------------------------------

function zoneOrder(gym, z) { return gym.zones[z] ? gym.zones[z].order : 99; }
function zoneDist(gym, z1, z2) { return Math.abs(zoneOrder(gym, z1) - zoneOrder(gym, z2)); }

// Best (smallest) zone distance between two movements, plus the chosen zones.
function pairZoneDistance(gym, a, b) {
  let best = { dist: 99, za: a.zones[0], zb: b.zones[0] };
  for (const za of a.zones) for (const zb of b.zones) {
    const d = zoneDist(gym, za, zb);
    if (d < best.dist) best = { dist: d, za, zb };
  }
  return best;
}

// ----------------------------------------------------------------------------
// Focus selection
// ----------------------------------------------------------------------------

function pickFocus(history, today, override, rng) {
  if (override && FOCUSES[override]) return override;
  const { patternFatigue } = computeFatigue(history, today);
  const lastFocus = history.length ? history[0].focus : null; // history is newest-first
  let best = null, bestScore = -Infinity;
  for (const name of Object.keys(FOCUSES)) {
    const f = FOCUSES[name];
    const pats = f.metconOnly ? f.metcon : f.s1;
    const score = pats.reduce((s, p) => s + freshness(p, patternFatigue), 0) / pats.length;
    // Penalize repeating the most recent focus; add a little jitter so equally-fresh
    // days (e.g. a fresh week) still vary instead of always defaulting to the first.
    let adj = name === lastFocus ? score - 1 : score;
    if (rng) adj += rng() * 0.15;
    if (adj > bestScore) { bestScore = adj; best = name; }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Movement selection
// ----------------------------------------------------------------------------

function candidatesFor(movements, { patterns, role, loadable, cardio }) {
  return movements.filter((m) => {
    if (patterns && !patterns.includes(m.pattern)) return false;
    if (role && !(m.roles || []).includes(role)) return false;
    if (loadable !== undefined && m.loadable !== loadable) return false;
    if (cardio !== undefined && m.cardio !== cardio) return false;
    return true;
  });
}

function scoreByFreshness(m, patternFatigue, biasFn) {
  let s = freshness(m.pattern, patternFatigue);
  if (biasFn) s += biasFn(m);
  return s;
}

// ----------------------------------------------------------------------------
// Load rounding
// ----------------------------------------------------------------------------

function nearestInLadder(target, ladder) {
  let best = ladder[0];
  for (const v of ladder) if (Math.abs(v - target) < Math.abs(best - target)) best = v;
  return best;
}

// Achievable barbell totals = bar + 2*(sum of any plates per side).
function nearestBarbell(target, barLb, plates) {
  // Build the set of achievable per-side sums up to a sensible ceiling.
  const ceiling = Math.max(0, (target - barLb) / 2) + Math.max(...plates) + 5;
  const sums = new Set([0]);
  for (let added = true; added; ) {
    added = false;
    for (const v of Array.from(sums)) {
      for (const p of plates) {
        const ns = +(v + p).toFixed(2);
        if (ns <= ceiling && !sums.has(ns)) { sums.add(ns); added = true; }
      }
    }
  }
  let best = barLb;
  for (const perSide of sums) {
    const total = +(barLb + 2 * perSide).toFixed(2);
    if (Math.abs(total - target) < Math.abs(best - target)) best = total;
  }
  return best;
}

// Returns { display, valueLb } for a target load on a given implement.
function roundLoad(targetLb, implement, inv, barKg) {
  if (!targetLb || targetLb <= 0) return null;
  switch (implement) {
    case "dumbbell": {
      const v = nearestInLadder(targetLb, inv.dumbbells_lb);
      return { display: `${v} lb DB`, valueLb: v };
    }
    case "kettlebell": {
      const targetKg = targetLb / inv.kg_to_lb;
      const kg = nearestInLadder(targetKg, inv.kettlebells_kg);
      return { display: `${kg} kg (${Math.round(kg * inv.kg_to_lb)} lb)`, valueLb: Math.round(kg * inv.kg_to_lb) };
    }
    case "barbell": {
      const barLb = Math.round((barKg || inv.barbells.mens_kg) * inv.kg_to_lb);
      const total = nearestBarbell(targetLb, barLb, inv.plates_lb);
      return { display: `${total} lb (${barKg || inv.barbells.mens_kg}kg bar)`, valueLb: total };
    }
    default:
      return null; // machine / bodyweight / cardio → load not prescribed
  }
}

// Step one rung up/down a fixed weight ladder.
function stepLadder(current, dir, ladder) {
  const s = [...ladder].sort((a, b) => a - b);
  let idx = 0, best = Infinity;
  s.forEach((v, i) => { if (Math.abs(v - current) < best) { best = Math.abs(v - current); idx = i; } });
  return s[Math.min(s.length - 1, Math.max(0, idx + dir))];
}

// Next achievable weight one increment above/below current, per implement.
function nextAchievable(current, dir, implement, inv, barKg) {
  if (!dir) return current;
  if (implement === "dumbbell") return stepLadder(current, dir, inv.dumbbells_lb);
  if (implement === "kettlebell") return Math.round(stepLadder(current / inv.kg_to_lb, dir, inv.kettlebells_kg) * inv.kg_to_lb);
  if (implement === "barbell") return nearestBarbell(current + dir * 5, Math.round((barKg || inv.barbells.mens_kg) * inv.kg_to_lb), inv.plates_lb);
  return current;
}

// RPE/result → progression direction, accounting for how the set was logged:
//   skipped → no change · partial/missed → back off · assumed (fast-logged) → hold ·
//   measured → RPE rules (≤7 up, 8–9 hold, ≥10 down; blank RPE holds). See Discussion.md.
function progressDir(p) {
  if (!p) return 0;
  if (p.status === "skipped") return 0;
  if (p.status === "partial") return -1;
  if (p.completed === false) return -1;            // legacy / explicit miss
  if (p.source === "assumed") return 0;            // fast-logged: stay conservative
  if (p.rpe != null && p.rpe <= 7) return 1;
  if (p.rpe != null && p.rpe >= 10) return -1;
  return 0;                                        // measured @ RPE 8–9, or RPE left blank
}

// His/hers load suggestion. Prefers your logged working weight (with progression from last
// RPE); falls back to a %1RM estimate if you've entered a 1RM; otherwise prompts you to enter.
function loadSuggestion(movement, reps, maxes, settings, inv, progress) {
  if (!movement.loadable) return null;
  const pct = pctForReps(reps);
  const out = { pct };
  for (const who of ["him", "her"]) {
    const barKg = settings.bars && settings.bars[who] === "womens" ? inv.barbells.womens_kg : inv.barbells.mens_kg;
    const p = progress && progress[movement.id] && progress[movement.id][who];
    if (p && p.load) {
      const target = nextAchievable(p.load, progressDir(p), movement.implement, inv, barKg);
      const r = roundLoad(target, movement.implement, inv, barKg) || { display: `${target} lb`, valueLb: target };
      out[who] = { display: r.display, valueLb: r.valueLb, last: `last ${p.load}${p.rpe != null ? ` @RPE ${p.rpe}` : ""}` };
      continue;
    }
    const e1rm = maxes[movement.id] ? maxes[movement.id][who] : null;
    if (e1rm) {
      const r = roundLoad(e1rm * pct, movement.implement, inv, barKg) || { display: `${Math.round(e1rm * pct)} lb`, valueLb: Math.round(e1rm * pct) };
      out[who] = { display: r.display, valueLb: r.valueLb, last: null };
    } else {
      out[who] = { display: "enter weight", valueLb: null, last: null };
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Per-set logging model (see Discussion.md)
// ----------------------------------------------------------------------------

// How a movement is logged + progressed. Drives which fields the log form shows.
function trackingType(m) {
  if (!m) return "reps";
  if (m.loadable) return "load_reps";
  if (m.unit === "time") return "time";
  if (m.pattern === "carry" || m.unit === "distance") return "distance";
  if (m.cardio) return "cardio";
  return "reps"; // bodyweight reps
}

// Pull a target hold length (seconds) out of a prescription like "3 × 45–60s",
// ":30–:45 hold", "30s hold". Returns the top of the range, or null if none found.
function parseTargetSeconds(presc) {
  if (!presc) return null;
  const nums = [];
  const re = /:(\d{1,3})|(\d{1,3})\s*s\b|(\d{1,3})\s*sec/gi;
  let mm;
  while ((mm = re.exec(presc))) { const v = mm[1] || mm[2] || mm[3]; if (v) nums.push(parseInt(v, 10)); }
  return nums.length ? Math.max(...nums) : null;
}

// The weight you can repeat across all working sets: the most common load (ties → the lower).
// For a top-set/backoff like [135,115,115] this is 115, not the 135 top set.
function repeatableLoad(sets) {
  const counts = new Map();
  for (const s of sets) counts.set(s.load, (counts.get(s.load) || 0) + 1);
  let best = null, bestN = 0;
  for (const [load, n] of counts) {
    if (n > bestN || (n === bestN && (best === null || load < best))) { best = load; bestN = n; }
  }
  return best;
}

// Turn a raw per-person log input into the canonical progress record. Pure + testable.
// raw: { trackingType, status, rpe, anyEntered, sets:[{load,reps,completed}], seconds, targetSeconds, reps, date }
// source = "measured" if the user entered actual data, else "assumed" (fast-logged).
function summarizePerf(raw) {
  const tt = raw.trackingType || "load_reps";
  const status = raw.status || "done";
  const source = raw.source || (raw.anyEntered ? "measured" : "assumed");
  const out = { status, source, rpe: raw.rpe != null ? raw.rpe : null, completed: status !== "skipped", trackingType: tt };
  if (raw.date) out.date = raw.date;
  if (tt === "load_reps") {
    const sets = (raw.sets || []).filter((s) => s && s.load > 0);
    if (sets.length) {
      out.sets = sets.map((s) => ({ load: s.load, reps: s.reps != null ? s.reps : null, completed: s.completed !== false }));
      out.top = Math.max(...sets.map((s) => s.load));
      out.load = repeatableLoad(sets); // weight you can repeat across sets (drives suggestions)
    }
  } else if (tt === "time") {
    if (raw.seconds != null) out.seconds = raw.seconds;
    if (raw.targetSeconds != null) out.targetSeconds = raw.targetSeconds;
  } else if (raw.reps != null) {
    out.reps = raw.reps;
  }
  return out;
}

// Suggested hold length per person from last performance: hit the target → small bump (~+5s);
// missed it (partial, or held less than target) → suggest what you actually held (floored to 5s).
function holdSuggestion(movement, targetSeconds, progress) {
  if (!targetSeconds) return null;
  const out = {};
  for (const who of ["him", "her"]) {
    const p = progress && progress[movement.id] && progress[movement.id][who];
    let secs = targetSeconds, last = null;
    if (p && p.seconds != null) {
      last = `last ${p.seconds}s`;
      const tgt = p.targetSeconds || targetSeconds;
      secs = (p.status === "partial" || p.seconds < tgt) ? Math.max(15, Math.floor(p.seconds / 5) * 5) : p.seconds + 5;
    } else if (p && p.status === "partial") {
      secs = Math.max(15, targetSeconds - 10);
    }
    out[who] = { seconds: secs, display: `${secs}s`, last };
  }
  return out;
}

// Aggregate a movement+person's newest-first log entries into last / best / session count.
function summarizeMovementLogs(entries) {
  if (!entries || !entries.length) return null;
  const last = entries[0];
  let best = null;
  for (const e of entries) {
    if (e.trackingType === "time") {
      if (e.seconds != null && (!best || e.seconds > (best.seconds || 0))) best = { seconds: e.seconds, date: e.date };
    } else {
      const w = e.top != null ? e.top : e.load;
      if (w != null && (!best || w > (best.load || 0))) best = { load: w, date: e.date };
    }
  }
  return { last, best, sessions: entries.length };
}

// ----------------------------------------------------------------------------
// Session builder
// ----------------------------------------------------------------------------

function chooseSchemeS1(rng) {
  const options = [
    { sets: 5, reps: 3, note: "@ ~RPE 8–9" },
    { sets: 4, reps: 4, note: "@ ~RPE 8" },
    { label: "build to a heavy 3", reps: 3, note: "build to ~3RM" },
    { sets: 5, reps: 5, note: "@ ~RPE 7–8" },
  ];
  return options[Math.floor(rng() * options.length)];
}

function chooseMetconStructure(rng) {
  const options = [
    { name: "AMRAP", detail: "AMRAP 12 min", minutes: 12 },
    { name: "EMOM", detail: "EMOM 12 (alternate movements each minute)", minutes: 12 },
    { name: "Rounds for time", detail: "4 rounds for time", minutes: 12 },
    { name: "Intervals", detail: "5 rounds — 2:00 on / 1:00 off", minutes: 15 },
    { name: "Chipper", detail: "1 round for time (chipper)", minutes: 14 },
  ];
  return options[Math.floor(rng() * options.length)];
}

function buildSession(data, opts) {
  const { movements, gym } = data;
  const today = opts.today;
  const history = opts.history || [];
  const maxes = opts.maxes || {};
  const settings = opts.settings || {};
  const progress = opts.progress || {};
  const inv = gym.inventory;
  const rng = makeRng(opts.seed || 1);

  const focus = pickFocus(history, today, opts.focusOverride, rng);
  const cfg = FOCUSES[focus];
  const { patternFatigue, muscleFatigue } = computeFatigue(history, today);
  const bias = balanceBias(history, today);
  const pool = filterCandidates(movements, { today, history, avoidList: opts.avoidList || [] });
  // On busy weekdays, bias away from movements stuck in a crowded zone (the bench/DB end).
  const busyToday = isBusyDay(DOW[new Date(today + "T00:00:00").getDay()], gym.crowd);
  const sbf = (m, biasFn) => scoreByFreshness(m, patternFatigue, biasFn) - crowdPenalty(m, busyToday, gym.crowd);

  const blocks = [];
  const usedMuscles = new Set();
  const usedIds = new Set();

  function note(id) { usedIds.add(id); }

  // --- Warm Up -------------------------------------------------------------
  // Light cardio + bodyweight mobility (no loaded lifts), biased toward the body
  // regions this session will actually train.
  const targetRegions = computeTargetRegions(cfg);
  const warmCardio = candidatesFor(pool, { role: "warmup", cardio: true });
  const warmMob = candidatesFor(pool, { role: "warmup", cardio: false }).filter((m) => !m.loadable && !usedIds.has(m.id));
  const warmItems = [];
  if (warmCardio.length) { const c = warmCardio[Math.floor(rng() * warmCardio.length)]; warmItems.push({ movement: c, prescription: prescribe(c, "warmup", rng) }); note(c.id); }
  // Warm up the regions this session trains (full-body mobility always ok); fall back if too few.
  const onTargetWarm = (m) => targetRegions.has(m.region) || m.region === "full";
  const mobScore = (m) => 1 + (onTargetWarm(m) ? 0.8 : 0);
  let mobPool = warmMob.filter(onTargetWarm);
  if (mobPool.length < 3) mobPool = warmMob.slice();
  for (let i = 0; i < 3 && mobPool.length; i++) {
    const m = pickWeighted(mobPool, mobScore, rng);
    warmItems.push({ movement: m, prescription: prescribe(m, "warmup", rng) });
    note(m.id); mobPool = mobPool.filter((x) => x.id !== m.id);
  }
  blocks.push({ name: "Warm Up", time: "~8 min", structure: "light mobility ramp", items: warmItems });

  // --- Strength 1 & 2 (skipped on Conditioning days) -----------------------
  if (!cfg.metconOnly) {
    // Strength 1: main loadable lift in the focus pattern, freshest wins.
    let s1cands = candidatesFor(pool, { patterns: cfg.s1, role: "strength1", loadable: true }).filter((m) => !usedIds.has(m.id));
    if (!s1cands.length) s1cands = candidatesFor(pool, { patterns: cfg.s1, role: "strength1" }).filter((m) => !usedIds.has(m.id));
    if (!s1cands.length) s1cands = candidatesFor(pool, { patterns: cfg.s1, role: "strength1" });
    const s1 = pickWeighted(s1cands, (m) => sbf(m, (mm) => {
      let b = 0;
      if (mm.pattern === "squat") b += bias.squatBias * 0.2;
      if (mm.pattern === "hinge") b += bias.hingeBias * 0.2;
      return b;
    }), rng);
    if (s1) {
      const scheme = chooseSchemeS1(rng);
      const reps = scheme.reps;
      const presc = scheme.label ? `${scheme.label} (${scheme.note})` : `${scheme.sets}×${reps} ${scheme.note}`;
      blocks.push({
        name: "Strength 1", time: "12–15 min", structure: "main lift",
        items: [{ movement: s1, prescription: presc, load: loadSuggestion(s1, reps, maxes, settings, inv, progress) }],
      });
      note(s1.id); (s1.muscles || []).forEach((m) => usedMuscles.add(m));
    }

    // Strength 2: a complementary push/pull paired with a unilateral/core piece.
    // We enumerate VALID pairs (same/adjacent zone) up front so a superset can never
    // span distant zones — the one firm gym-logistics rule.
    const pushPullBias = (m) => {
      if (m.pattern === "h-push" || m.pattern === "v-push") return bias.pushBias * 0.2;
      if (m.pattern === "h-pull" || m.pattern === "v-pull") return bias.pullBias * 0.2;
      return 0;
    };
    const aCands = candidatesFor(pool, { patterns: cfg.s2a, role: "strength2" }).filter((m) => !usedIds.has(m.id));
    // Partner pool: accessory or core moves (core moves carry a "core" role, not "strength2").
    const bCands = candidatesFor(pool, { patterns: cfg.s2b })
      .filter((m) => !usedIds.has(m.id) && ((m.roles || []).includes("strength2") || (m.roles || []).includes("core")));
    let a = null, b = null;
    const pairs = [];
    for (const ca of aCands) for (const cb of bCands) {
      if (ca.id === cb.id) continue;
      const dist = pairZoneDistance(gym, ca, cb).dist;
      if (dist <= 1) {
        // Strongly prefer pairs that share the EXACT same zone (dist 0), so a superset
        // reads honestly (e.g. machine + machine in C, or banded pull-up + lift in B)
        // instead of straddling two zones.
        const zoneBonus = dist === 0 ? 0.8 : 0;
        pairs.push({ a: ca, b: cb, score: sbf(ca, pushPullBias) + sbf(cb) + zoneBonus });
      }
    }
    if (pairs.length) {
      const chosen = pickWeighted(pairs, (p) => p.score, rng);
      a = chosen.a; b = chosen.b;
    } else if (aCands.length) {
      // No zone-compatible partner — run the accessory solo rather than make them walk.
      a = pickWeighted(aCands, (m) => sbf(m, pushPullBias), rng);
    }
    const s2items = [];
    if (a) { s2items.push({ movement: a, prescription: "4×8 @ RPE 8", load: loadSuggestion(a, 8, maxes, settings, inv, progress) }); note(a.id); (a.muscles || []).forEach((m) => usedMuscles.add(m)); }
    if (b) { s2items.push({ movement: b, prescription: prescribe(b, "strength2", rng), load: loadSuggestion(b, 12, maxes, settings, inv, progress) }); note(b.id); (b.muscles || []).forEach((m) => usedMuscles.add(m)); }
    if (s2items.length) blocks.push({ name: "Strength 2 (superset)", time: "9–10 min", structure: "superset", items: s2items });
  }

  // --- MetCon --------------------------------------------------------------
  const struct = chooseMetconStructure(rng);
  const metconN = cfg.metconOnly ? 4 : 3;
  // Avoid muscles we just hammered; prefer fresh patterns.
  const muscleAvoid = (m) => {
    const overlap = (m.muscles || []).filter((x) => usedMuscles.has(x)).length;
    return -overlap * 0.5;
  };
  const cardioCands = candidatesFor(pool, { patterns: cfg.metcon, cardio: true });
  // Don't reuse movements already in the warm-up / strength blocks.
  const moveCands = candidatesFor(pool, { patterns: cfg.metcon, cardio: false }).filter((m) => !usedIds.has(m.id));
  const metItems = [];
  // Always include one cardio modality (prefer one not used in the warm-up).
  if (cardioCands.length) {
    const freshCardio = cardioCands.filter((m) => !usedIds.has(m.id));
    const c = pickWeighted(freshCardio.length ? freshCardio : cardioCands, (m) => sbf(m), rng);
    metItems.push({ movement: c, prescription: prescribe(c, "metcon", rng) }); note(c.id);
  }
  const used = new Set(metItems.map((i) => i.movement.id));
  let pickPool = moveCands.filter((m) => !used.has(m.id));
  for (let i = metItems.length; i < metconN && pickPool.length; i++) {
    const m = pickWeighted(pickPool, (mm) => sbf(mm, muscleAvoid) + 0.3, rng);
    metItems.push({ movement: m, prescription: prescribe(m, "metcon", rng) });
    used.add(m.id);
    pickPool = pickPool.filter((x) => x.id !== m.id);
  }
  blocks.push({ name: "MetCon", time: `~${struct.minutes} min`, structure: struct.detail, items: metItems });

  // --- Zone assignment + path ---------------------------------------------
  assignZones(gym, blocks);
  const path = blocks.map((bk) => bk.zone).filter((z, i, arr) => z && (i === 0 || z !== arr[i - 1]));

  return { date: today, focus, mode: "freestyle", zonePath: path, blocks, seed: opts.seed || 1 };
}

// ----------------------------------------------------------------------------
// Prescriptive program: day archetypes + block engine (see Ideas.md)
// ----------------------------------------------------------------------------

// Each day has a clear identity: primary patterns it trains, forbidden patterns it
// will never include, an intensity cap, and an ordered list of block types. A "?"
// suffix marks an optional block (included roughly half the time).
const PROGRAM_DAYS = {
  "Push Strength": { category: "upper", primary: ["h-push", "v-push"], secondary: ["triceps", "side-delts"], forbidden: ["squat", "hinge", "lunge", "h-pull", "v-pull"], cap: "heavy",
    blocks: ["prep", "main_strength", "secondary_strength", "accessory_superset", "finisher?"] },
  "Lower Strength — Squat": { category: "lower", primary: ["squat"], secondary: ["lunge", "calves", "core", "hinge", "glutes"], forbidden: ["h-push", "v-push", "h-pull", "v-pull"], cap: "heavy",
    blocks: ["prep", "main_strength", "secondary_strength", "accessory", "core"] },
  "Pull Strength": { category: "upper", primary: ["h-pull", "v-pull"], secondary: ["biceps", "rear-delts"], forbidden: ["squat", "hinge", "lunge", "h-push", "v-push"], cap: "heavy",
    blocks: ["prep", "main_strength", "secondary_strength", "accessory_superset", "carry_core"] },
  "Conditioning + Core": { category: "conditioning", primary: ["conditioning", "core"], secondary: ["core"], forbidden: [], cap: "moderate",
    blocks: ["prep", "conditioning", "core", "mobility"] },
  "Upper Hypertrophy": { category: "upper", primary: ["h-push", "h-pull", "v-push", "v-pull"], secondary: ["side-delts", "rear-delts", "biceps", "triceps"], forbidden: ["squat", "hinge", "lunge"], cap: "moderate",
    blocks: ["prep", "superset_a", "superset_b", "arms_delts"] },
  "Lower Hypertrophy — Hinge": { category: "lower", primary: ["hinge"], secondary: ["lunge", "calves", "core", "glutes"], forbidden: ["h-push", "v-push", "h-pull", "v-pull"], cap: "moderate",
    blocks: ["prep", "main_hypertrophy", "secondary_hypertrophy", "accessory", "calves_core"] },
  "Pump / Recovery": { category: "recovery", primary: ["biceps", "triceps", "side-delts", "rear-delts", "calves", "core"], secondary: ["biceps", "triceps", "side-delts", "rear-delts", "calves"], forbidden: ["squat", "hinge", "lunge", "olympic"], cap: "easy",
    blocks: ["easy_cardio", "pump", "core", "mobility"] },
};

function patternsFor(cfg, which) {
  const p = cfg.primary || [], s = cfg.secondary || [];
  if (which === "primary") return p;
  if (which === "secondary") return s.length ? s : p;
  return [...new Set([...p, ...s])];
}

// ---- Program sequencing + 4-week mesocycle ----

// Default program "Balanced Hypertrophy + Fitness": 6 required days + optional 7th.
const PROGRAM_SEQUENCE = [
  "Push Strength", "Lower Strength — Squat", "Pull Strength",
  "Conditioning + Core", "Upper Hypertrophy", "Lower Hypertrophy — Hinge",
  "Pump / Recovery",
];
function programSequence(daysPerWeek) { return PROGRAM_SEQUENCE.slice(0, daysPerWeek === 7 ? 7 : 6); }

// Major muscle regions used for the "don't train the same body parts two days running" guard.
const MUSCLE_REGIONS = new Set(["push", "pull", "lower"]);
// Regions a program day emphasizes (empty for conditioning/recovery days — light enough to
// follow anything).
function dayMuscleRegions(cfg) {
  if (!cfg || cfg.category === "recovery" || cfg.category === "conditioning") return new Set();
  return new Set((cfg.primary || []).map((p) => PATTERN_REGION[p]).filter((r) => MUSCLE_REGIONS.has(r)));
}
// Regions a logged session actually worked hard (heavy/med items only — pump/accessory/cardio
// don't block the next day).
function sessionMuscleRegions(session) {
  const set = new Set();
  for (const it of (session && session.items) || []) {
    if (it.intensity !== "heavy" && it.intensity !== "med") continue;
    const r = PATTERN_REGION[it.pattern];
    if (MUSCLE_REGIONS.has(r)) set.add(r);
  }
  return set;
}
function regionsOverlap(a, b) { for (const r of a) if (b.has(r)) return true; return false; }

// Next program day. If you trained yesterday/today, skip ahead to the next day in the sequence
// that doesn't repeat that session's major region (so no similar body parts two days running).
function nextProgramDay(prog, history, today) {
  const seq = programSequence(prog.daysPerWeek);
  const start = (prog.logged || 0) % seq.length;
  const last = history && history[0];
  const recent = last && today != null && daysBetween(last.date, today) <= 1;
  if (recent) {
    const lastRegions = sessionMuscleRegions(last);
    if (lastRegions.size) {
      for (let i = 0; i < seq.length; i++) {
        const day = seq[(start + i) % seq.length];
        if (!regionsOverlap(dayMuscleRegions(PROGRAM_DAYS[day]), lastRegions)) return day;
      }
    }
  }
  return seq[start]; // no recent session, or every day overlaps → keep the sequence order
}
function dayNumber(prog) { const seq = programSequence(prog.daysPerWeek); return ((prog.logged || 0) % seq.length) + 1; }
function mesocycleWeek(prog) { const seq = programSequence(prog.daysPerWeek); return (Math.floor((prog.logged || 0) / seq.length) % 4) + 1; }

// 4-week wave: ramp volume/intensity weeks 1–3, deload week 4.
const MESO = {
  1: { name: "Baseline", deload: false },
  2: { name: "Build", deload: false },
  3: { name: "Push", deload: false },
  4: { name: "Deload", deload: true },
};

// ---- 12-week macrocycle: three 4-week blocks, each with its own set/rep/RPE tables ----
const BLOCK_KEYS = ["hypertrophy_base", "strength_biased", "fitness_performance"];
const BLOCK_NAMES = { hypertrophy_base: "Hypertrophy Base", strength_biased: "Strength-Biased Hypertrophy", fitness_performance: "Fitness / Performance" };

// Per block: prescriptions by tier (main = heavy/main lift; secondary; accessory; hyper =
// hypertrophy-day mains that must stay in the 8–15 range). week1–4 = baseline/build/push/deload.
const MACRO_BLOCKS = {
  hypertrophy_base: {
    main: { week1: { sets: 3, reps: "8", rpe: "6-7" }, week2: { sets: 4, reps: "8", rpe: "7" }, week3: { sets: 4, reps: "8-10", rpe: "8" }, week4: { sets: 2, reps: "8", rpe: "6" } },
    secondary: { week1: { sets: 3, reps: "10", rpe: "7" }, week2: { sets: 3, reps: "10-12", rpe: "7-8" }, week3: { sets: 4, reps: "10-12", rpe: "8" }, week4: { sets: 2, reps: "10", rpe: "6" } },
    accessory: { week1: { sets: 2, reps: "12-15", rpe: "7" }, week2: { sets: 3, reps: "12-15", rpe: "7-8" }, week3: { sets: 3, reps: "12-15", rpe: "8-9" }, week4: { sets: 1, reps: "12", rpe: "6" } },
    hyper: { week1: { sets: 3, reps: "10-12", rpe: "7" }, week2: { sets: 4, reps: "10-12", rpe: "7-8" }, week3: { sets: 4, reps: "10-12", rpe: "8" }, week4: { sets: 2, reps: "12", rpe: "6" } },
  },
  strength_biased: {
    main: { week1: { sets: 4, reps: "5", rpe: "7" }, week2: { sets: 5, reps: "4", rpe: "7-8" }, week3: { sets: 5, reps: "3", rpe: "8-9" }, week4: { sets: 3, reps: "5", rpe: "6" } },
    secondary: { week1: { sets: 3, reps: "6-8", rpe: "7" }, week2: { sets: 4, reps: "6-8", rpe: "8" }, week3: { sets: 4, reps: "6", rpe: "8" }, week4: { sets: 2, reps: "8", rpe: "6" } },
    accessory: { week1: { sets: 2, reps: "10-12", rpe: "7" }, week2: { sets: 3, reps: "10-12", rpe: "7-8" }, week3: { sets: 3, reps: "8-12", rpe: "8" }, week4: { sets: 1, reps: "10-12", rpe: "6" } },
    hyper: { week1: { sets: 3, reps: "8-10", rpe: "7" }, week2: { sets: 3, reps: "8-10", rpe: "8" }, week3: { sets: 3, reps: "8-10", rpe: "8" }, week4: { sets: 2, reps: "10", rpe: "6" } },
  },
  fitness_performance: {
    main: { week1: { sets: 3, reps: "6", rpe: "7" }, week2: { sets: 4, reps: "6", rpe: "7-8" }, week3: { sets: 3, reps: "5 + rep-out", rpe: "8" }, week4: { sets: 2, reps: "6", rpe: "6" } },
    secondary: { week1: { sets: 3, reps: "8-10", rpe: "7" }, week2: { sets: 3, reps: "8-10", rpe: "7-8" }, week3: { sets: 3, reps: "8", rpe: "8" }, week4: { sets: 2, reps: "8", rpe: "6" } },
    accessory: { week1: { sets: 2, reps: "12-15", rpe: "7" }, week2: { sets: 2, reps: "12-15", rpe: "7-8" }, week3: { sets: 3, reps: "12-20", rpe: "8" }, week4: { sets: 1, reps: "12-15", rpe: "6" } },
    hyper: { week1: { sets: 3, reps: "10-15", rpe: "7" }, week2: { sets: 3, reps: "12-15", rpe: "7-8" }, week3: { sets: 3, reps: "10-15", rpe: "8" }, week4: { sets: 2, reps: "12", rpe: "6" } },
  },
};

function macrocycleWeek(prog) { const seq = programSequence(prog.daysPerWeek); const cycles = Math.floor((prog.logged || 0) / seq.length); return (cycles % 12) + 1; }
function macroBlockIndex(prog) { return Math.floor((macrocycleWeek(prog) - 1) / 4); } // 0,1,2
function macroBlockKey(prog) { return BLOCK_KEYS[macroBlockIndex(prog)]; }

function firstRep(reps) { const m = String(reps).match(/\d+/); return m ? parseInt(m[0], 10) : 8; }
// Resolve a slot's scheme string + load-rep target for a given tier/block/week.
function slotScheme(tier, blockKey, week) {
  const b = MACRO_BLOCKS[blockKey] || MACRO_BLOCKS.hypertrophy_base;
  const t = b[tier] || b.accessory;
  const w = t["week" + week] || t.week1;
  return { scheme: `${w.sets}×${w.reps} @ RPE ${w.rpe}${week === 4 ? " (deload)" : ""}`, reps: firstRep(w.reps) };
}

// Block 2 (Strength-Biased) closes with a test + deload week instead of a plain deload:
// an OPTIONAL clean 3RM on the strength-day main lift. Week 7 (strength_biased week 3) is
// already the heavy-triple exposure week (5×3 @ RPE 8-9). See HighWeightReps.md.
function isTestWeek(blockKey, week) { return blockKey === "strength_biased" && week === 4; }
const TEST_MAIN_SCHEME = "Optional test: work up to a clean 3RM @ RPE 9, then 2×8 @ ~70% backoff. A clean heavy triple, not a true max — stop if form breaks.";
// Estimate 1RM from a heavy triple (≈ 3RM × 1.10), per the test protocol.
function estimate1RM(weight, mult) { return Math.round(weight * (mult || 1.10)); }

// ---- Weekly volume accounting (readout) ----
const VOLUME_TARGETS = { chest: 10, back: 12, quads: 10, "ham/glutes": 10, delts: 10, arms: 10, calves: 8, core: 8 };
const MUSCLE_BUCKET = {
  chest: "chest", back: "back", lats: "back", "upper-back": "back",
  quads: "quads", glutes: "ham/glutes", hamstrings: "ham/glutes",
  shoulders: "delts", delts: "delts", "rear-delts": "delts", "front-delts": "delts",
  biceps: "arms", triceps: "arms", forearms: "arms", calves: "calves", core: "core", obliques: "core",
};
// Parse the number of working sets from a prescription like "4×5", "3×12–15", "3 × 45–60s".
function parseSets(p) {
  if (!p) return 0;
  const m = String(p).match(/^(\d+)\s*[×x]/);
  if (m) return parseInt(m[1], 10);
  if (/build to|work up to|3rm/i.test(p)) return 1; // top set of a build-up / 3RM test
  return 0;
}
function weeklySets(history, today) {
  const sets = {}; Object.keys(VOLUME_TARGETS).forEach((k) => sets[k] = 0);
  let cardioExposures = 0;
  for (const s of history) {
    const ago = daysBetween(s.date, today);
    if (ago < 0 || ago > 7) continue;
    let hadCardio = false;
    for (const it of s.items || []) {
      const n = it.sets || 0;
      if (n > 0) {
        // De-dupe buckets per movement so a lift tagged e.g. ["hamstrings","glutes"]
        // (both -> "ham/glutes") counts its sets once, not twice.
        const buckets = new Set((it.muscles || []).map((mu) => MUSCLE_BUCKET[mu]).filter(Boolean));
        for (const b of buckets) sets[b] += n;
      }
      // Only real conditioning work counts as a cardio exposure — not the warm-up's easy
      // cardio or a short finisher cap.
      if (it.pattern === "conditioning" && ["conditioning", "metcon"].includes(it.role)) hadCardio = true;
    }
    if (hadCardio) cardioExposures++;
  }
  return { sets, cardioExposures, targets: VOLUME_TARGETS };
}

function buildProgramSession(data, opts) {
  const { movements, gym } = data;
  const today = opts.today;
  const history = opts.history || [];
  const maxes = opts.maxes || {};
  const settings = opts.settings || {};
  const progress = opts.progress || {};
  const inv = gym.inventory;
  const rng = makeRng(opts.seed || 1);
  const busyToday = isBusyDay(DOW[new Date(today + "T00:00:00").getDay()], gym.crowd);
  const cfg = PROGRAM_DAYS[opts.day];
  if (!cfg) throw new Error("Unknown program day: " + opts.day);

  const week = opts.mesoWeek || 1;
  const block = opts.macroBlock || "hypertrophy_base";
  const deload = (MESO[week] || MESO[1]).deload;

  const { patternFatigue } = computeFatigue(history, today);
  const bias = balanceBias(history, today);
  const forbidden = new Set(cfg.forbidden || []);
  // Program mode draws only from conventional, repeatable movements (programDefault). The
  // CrossFit/Olympic/specialty moves stay available in Freestyle mode and as manual swaps.
  const pool = filterCandidates(movements, { today, history, avoidList: opts.avoidList || [] })
    .filter((m) => !forbidden.has(m.pattern))
    .filter((m) => m.programDefault !== false);
  const targetRegions = new Set([].concat(cfg.primary || [], cfg.secondary || []).map((p) => PATTERN_REGION[p]).filter(Boolean));

  const usedIds = new Set();
  const note = (m) => { usedIds.add(m.id); };

  // Slot stickiness: each trainable slot (day::role::ordinal) remembers the movement you
  // last did, so progression accumulates on one lift instead of scattering across swaps.
  const slots = opts.slots || {};
  const slotCounter = {};
  const slotKey = (role) => { const i = slotCounter[role] || 0; slotCounter[role] = i + 1; return `${opts.day}::${role}::${i}`; };

  function cand(spec) {
    return pool.filter((m) =>
      (!spec.patterns || spec.patterns.includes(m.pattern)) &&
      (!spec.roles || (m.roles || []).some((r) => spec.roles.includes(r))) &&
      (spec.loadable === undefined || m.loadable === spec.loadable) &&
      (spec.cardio === undefined || m.cardio === spec.cardio) &&
      !usedIds.has(m.id));
  }
  function score(m) {
    let s = freshness(m.pattern, patternFatigue);
    s += tierBonus(m); // prefer core staples over secondary variations
    s -= crowdPenalty(m, busyToday, gym.crowd); // on busy days, avoid crowded-only zones
    if (m.pattern === "h-push" || m.pattern === "v-push") s += bias.pushBias * 0.15;
    if (m.pattern === "h-pull" || m.pattern === "v-pull") s += bias.pullBias * 0.15;
    if (m.pattern === "squat") s += bias.squatBias * 0.15;
    if (m.pattern === "hinge") s += bias.hingeBias * 0.15;
    return s;
  }
  function item(m, reps, scheme, slot) {
    return { movement: m, prescription: scheme || prescribe(m, slot || "strength2", rng), load: loadSuggestion(m, reps, maxes, settings, inv, progress) };
  }
  function single(name, role, intensity, spec) {
    let cs = cand({ patterns: spec.patterns, roles: spec.roles, loadable: spec.loadable });
    if (!cs.length) cs = cand({ patterns: spec.patterns, roles: spec.roles });
    if (!cs.length) cs = cand({ patterns: spec.patterns });
    if (!cs.length) return null;
    const sk = slotKey(role);
    // Reuse last time's movement for this slot if it's still a valid choice (stickiness).
    let m = slots[sk] ? cs.find((x) => x.id === slots[sk]) : null;
    if (!m) m = pickWeighted(cs, score, rng);
    note(m);
    const it = item(m, spec.reps, spec.scheme, spec.slot); it.slotKey = sk;
    return { name, role, intensity, items: [it] };
  }
  function superset(name, role, intensity, specA, specB, reps, scheme) {
    const sk0 = slotKey(role), sk1 = slotKey(role);
    const aS = cand(specA), bS = cand(specB);
    const pairs = [];
    for (const a of aS) for (const b of bS) {
      if (a.id === b.id) continue;
      const d = pairZoneDistance(gym, a, b).dist;
      if (d <= 1) {
        let s = score(a) + score(b) + (d === 0 ? 0.8 : 0);
        if (slots[sk0] === a.id) s += 0.6; // soft stickiness for accessory slots
        if (slots[sk1] === b.id) s += 0.6;
        pairs.push({ a, b, s });
      }
    }
    // Prefer pairs that train different patterns (e.g. triceps + side-delts, not triceps + triceps).
    const mixed = pairs.filter((p) => p.a.pattern !== p.b.pattern);
    const usePairs = mixed.length ? mixed : pairs;
    let items = [];
    if (usePairs.length) {
      const p = pickWeighted(usePairs, (x) => x.s, rng);
      const ia = item(p.a, reps, scheme); ia.slotKey = sk0;
      const ib = item(p.b, reps, scheme); ib.slotKey = sk1;
      items = [ia, ib]; note(p.a); note(p.b);
    } else if (aS.length) {
      const a = pickWeighted(aS, score, rng); const ia = item(a, reps, scheme); ia.slotKey = sk0; items = [ia]; note(a);
    } else return null;
    return { name, role, intensity, items };
  }
  function circuit(name, role, intensity, spec, n, scheme, reps) {
    let cs = cand(spec); const items = [];
    for (let i = 0; i < n && cs.length; i++) { const m = pickWeighted(cs, score, rng); items.push(item(m, reps, scheme)); note(m); cs = cs.filter((x) => x.id !== m.id); }
    return items.length ? { name, role, intensity, items } : null;
  }
  function prep() {
    const wc = cand({ roles: ["warmup"], cardio: true });
    const wm = cand({ roles: ["warmup"], cardio: false, loadable: false });
    const items = [];
    if (wc.length) { const c = wc[Math.floor(rng() * wc.length)]; items.push({ movement: c, prescription: prescribe(c, "warmup", rng) }); note(c); }
    // Warm up the body parts you're about to train: keep only mobility that matches the day's
    // regions (or full-body), so you don't do hip 90/90s before a bench press. Fall back to the
    // full list only if too few match.
    const onTarget = (m) => targetRegions.has(m.region) || m.region === "full";
    let mp = wm.filter(onTarget);
    if (mp.length < 3) mp = wm.slice();
    const mob = (m) => 1 + (onTarget(m) ? 0.8 : 0);
    for (let i = 0; i < 3 && mp.length; i++) { const m = pickWeighted(mp, mob, rng); items.push({ movement: m, prescription: prescribe(m, "warmup", rng) }); note(m); mp = mp.filter((x) => x.id !== m.id); }
    return { name: "Warm Up / Prep", role: "warmup", intensity: "light", items };
  }
  function conditioning() {
    const struct = chooseMetconStructure(rng);
    const items = [];
    const cardio = cand({ patterns: ["conditioning"], cardio: true });
    if (cardio.length) { const c = pickWeighted(cardio, score, rng); items.push({ movement: c, prescription: prescribe(c, "metcon", rng) }); note(c); }
    let mp = cand({ patterns: ["conditioning"], cardio: false });
    for (let i = items.length; i < 3 && mp.length; i++) { const m = pickWeighted(mp, score, rng); items.push({ movement: m, prescription: prescribe(m, "metcon", rng) }); note(m); mp = mp.filter((x) => x.id !== m.id); }
    return { name: "Conditioning", role: "conditioning", intensity: cfg.cap === "easy" ? "light" : "med", structure: struct.detail, items };
  }
  function mobility() {
    let cs = cand({ patterns: ["mobility"] }); const items = [];
    for (let i = 0; i < 2 && cs.length; i++) { const m = pickWeighted(cs, (x) => 1 + ((targetRegions.has(x.region) || x.region === "full") ? 0.5 : 0), rng); items.push({ movement: m, prescription: "45–60s ea" }); note(m); cs = cs.filter((x) => x.id !== m.id); }
    return items.length ? { name: "Mobility", role: "mobility", intensity: "light", items } : null;
  }
  function comboBlock(name, specA, schemeA, repsA) {
    const items = [];
    const aS = cand(specA); if (aS.length) { const a = pickWeighted(aS, score, rng); items.push(item(a, repsA, schemeA, "metcon")); note(a); }
    const cS = cand({ patterns: ["core"] }); if (cS.length) { const c = pickWeighted(cS, score, rng); items.push(item(c, 12, null, "strength2")); note(c); }
    return items.length ? { name, role: "core", intensity: "light", items } : null;
  }
  // Short, focus-biased density finisher (e.g. a quick pump/cardio cap on push day).
  function finisher() {
    const items = [];
    const cardio = cand({ patterns: ["conditioning"], cardio: true });
    if (cardio.length) { const m = pickWeighted(cardio, score, rng); items.push({ movement: m, prescription: "6 min — easy/moderate" }); note(m); }
    const upper = cand({ patterns: patternsFor(cfg, "primarySecondary"), cardio: false, loadable: false });
    const pool2 = upper.length ? upper : cand({ patterns: patternsFor(cfg, "primarySecondary"), cardio: false });
    if (pool2.length) { const m = pickWeighted(pool2, score, rng); items.push({ movement: m, prescription: "AMRAP in time remaining", load: loadSuggestion(m, 12, maxes, settings, inv, progress) }); note(m); }
    return items.length ? { name: "Finisher (optional)", role: "finisher", intensity: "med", items } : null;
  }

  function build(token) {
    const optional = token.endsWith("?");
    const t = optional ? token.slice(0, -1) : token;
    if (optional && rng() < 0.5) return null;
    switch (t) {
      case "prep": return prep();
      case "main_strength": {
        if (isTestWeek(block, week)) {
          const b = single("Strength 1 — 3RM test (optional)", "strength1", "heavy", { patterns: patternsFor(cfg, "primary"), roles: ["strength1"], reps: 3, scheme: TEST_MAIN_SCHEME });
          if (b) b.items.forEach((it) => { it.test = true; it.testReps = 3; });
          return b;
        }
        const sc = slotScheme("main", block, week);
        return single("Strength 1 (main)", "strength1", deload ? "light" : "heavy", { patterns: patternsFor(cfg, "primary"), roles: ["strength1"], reps: sc.reps, scheme: sc.scheme });
      }
      case "secondary_strength": { const sc = slotScheme("secondary", block, week); return single("Strength 2 (secondary)", "strength2", "med", { patterns: patternsFor(cfg, "primarySecondary"), roles: ["strength2"], reps: sc.reps, scheme: sc.scheme }); }
      case "main_hypertrophy": { const sc = slotScheme("hyper", block, week); return single("Main (hypertrophy)", "strength1", "med", { patterns: patternsFor(cfg, "primary"), roles: ["strength1", "strength2"], reps: sc.reps, scheme: sc.scheme }); }
      case "secondary_hypertrophy": { const sc = slotScheme("accessory", block, week); return single("Secondary (hypertrophy)", "strength2", "med", { patterns: patternsFor(cfg, "primarySecondary"), roles: ["strength2", "accessory"], reps: sc.reps, scheme: sc.scheme }); }
      case "accessory": { const sc = slotScheme("accessory", block, week); return single("Accessory", "accessory", "light", { patterns: patternsFor(cfg, "secondary"), roles: ["accessory", "strength2"], reps: sc.reps, scheme: sc.scheme }); }
      case "accessory_superset": { const sc = slotScheme("accessory", block, week); return superset("Accessory superset", "accessory", "light", { patterns: patternsFor(cfg, "secondary"), roles: ["accessory", "strength2"] }, { patterns: patternsFor(cfg, "secondary").concat(["core"]), roles: ["accessory", "strength2", "core"] }, sc.reps, sc.scheme); }
      case "superset_a": { const sc = slotScheme("hyper", block, week); return superset("Superset A (push/pull)", "strength2", "med", { patterns: ["h-push", "v-push"], roles: ["strength2", "accessory"] }, { patterns: ["h-pull", "v-pull"], roles: ["strength2", "accessory"] }, sc.reps, sc.scheme); }
      case "superset_b": { const sc = slotScheme("hyper", block, week); return superset("Superset B (push/pull)", "strength2", "med", { patterns: ["v-push", "h-push"], roles: ["strength2", "accessory"] }, { patterns: ["v-pull", "h-pull"], roles: ["strength2", "accessory"] }, sc.reps, sc.scheme); }
      case "arms_delts": { const sc = slotScheme("accessory", block, week); return superset("Arms & Delts", "accessory", "light", { patterns: ["biceps", "triceps"], roles: ["accessory"] }, { patterns: ["side-delts", "rear-delts"], roles: ["accessory"] }, sc.reps, sc.scheme); }
      case "pump": return circuit("Pump Circuit", "accessory", "light", { patterns: ["biceps", "triceps", "side-delts", "rear-delts", "calves"], roles: ["accessory"] }, deload ? 2 : 3, "2–3×15–20 (easy)", 15);
      case "finisher": return deload ? null : finisher();
      case "core": return circuit("Core", "core", "light", { patterns: ["core"] }, 2, null, 12);
      case "carry_core": return comboBlock("Carry & Core", { patterns: ["carry"], roles: ["metcon"] }, null, 12);
      case "calves_core": return comboBlock("Calves & Core", { patterns: ["calves"], roles: ["accessory"] }, "3×15–20", 15);
      case "conditioning": return conditioning();
      case "mobility": return mobility();
      case "easy_cardio": { const c = cand({ patterns: ["conditioning"], cardio: true }); if (!c.length) return null; const m = pickWeighted(c, score, rng); note(m); return { name: "Easy Cardio (Zone 2)", role: "conditioning", intensity: "light", items: [{ movement: m, prescription: "20–30 min easy" }] }; }
      default: return null;
    }
  }

  const blocks = [];
  for (const token of cfg.blocks) { const b = build(token); if (b && b.items && b.items.length) blocks.push(b); }
  assignZones(gym, blocks);
  const path = blocks.map((bk) => bk.zone).filter((z, i, a) => z && (i === 0 || z !== a[i - 1]));
  return { date: today, focus: opts.day, mode: "program", category: cfg.category, zonePath: path, blocks, seed: opts.seed || 1 };
}


// Assign each block the zone that ALL its movements share (honest label). If the
// movements don't share a single zone (e.g. a superset straddling B and C), leave
// the block zone null and let each movement show its own zone in the UI.
function assignZones(gym, blocks) {
  let prev = null;
  for (const bk of blocks) {
    let shared = null;
    for (const it of bk.items) {
      const zs = it.movement.zones || [];
      shared = shared === null ? new Set(zs) : new Set(zs.filter((z) => shared.has(z)));
    }
    const arr = shared ? [...shared] : [];
    if (arr.length) {
      // Among the shared zones, pick the one closest to the previous block.
      arr.sort((z1, z2) => (prev ? zoneDist(gym, z1, prev) - zoneDist(gym, z2, prev) : zoneOrder(gym, z1) - zoneOrder(gym, z2)));
      bk.zone = arr[0];
      bk.zoneName = gym.zones[bk.zone] ? gym.zones[bk.zone].name : "";
      prev = bk.zone;
    } else {
      bk.zone = null;
      bk.zoneName = "";
    }
  }
}

// Turn a generated session into a loggable history entry (newest-first convention).
function sessionToHistoryEntry(session) {
  const items = [];
  for (const bk of session.blocks) {
    const role = bk.role || blockRole(bk.name);
    const intensity = bk.intensity || ROLE_INTENSITY[role] || "light";
    for (const it of bk.items) {
      items.push({ movementId: it.movement.id, pattern: it.movement.pattern, muscles: it.movement.muscles || [], intensity, role, sets: parseSets(it.prescription) });
    }
  }
  return { date: session.date, focus: session.focus, items };
}

function blockRole(name) {
  if (name.startsWith("Strength 1")) return "strength1";
  if (name.startsWith("Strength 2")) return "strength2";
  if (name.startsWith("Warm")) return "warmup";
  if (name.startsWith("MetCon")) return "metcon";
  return "metcon";
}

// Map a block role to the prescription slot used by prescribe().
function slotForRole(role) {
  if (role === "warmup" || role === "mobility") return "warmup";
  if (role === "strength1") return "strength1";
  if (role === "conditioning" || role === "finisher" || role === "metcon") return "metcon";
  return "strength2"; // strength2, accessory, core
}

// ----------------------------------------------------------------------------
// Swap: find an equivalent movement (same region, compatible role, near zone)
// ----------------------------------------------------------------------------

// Equivalent movements: same body region, same loadable/cardio nature, and at least
// one role in common (so an accessory swaps for an accessory, a main for a main).
function swapCandidates(data, currentMovement, opts) {
  const { movements, gym } = data;
  const pool = filterCandidates(movements, { today: opts.today, history: opts.history || [], avoidList: opts.avoidList || [] });
  return pool.filter((m) =>
    m.id !== currentMovement.id &&
    m.region === currentMovement.region &&
    m.loadable === currentMovement.loadable &&
    m.cardio === currentMovement.cardio &&
    (m.roles || []).some((r) => (currentMovement.roles || []).includes(r))
  ).sort((a, b) => pairZoneDistance(gym, currentMovement, a).dist - pairZoneDistance(gym, currentMovement, b).dist);
}

// ----------------------------------------------------------------------------
// Node export (for tests)
// ----------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeFatigue, freshness, balanceBias, filterCandidates, lastUsed,
    pickFocus, buildSession, buildProgramSession, roundLoad, nearestBarbell, nearestInLadder,
    loadSuggestion, swapCandidates, sessionToHistoryEntry, pctForReps, progressDir,
    trackingType, parseTargetSeconds, repeatableLoad, summarizePerf, holdSuggestion, summarizeMovementLogs,
    tierBonus, PATTERN_REGION, isBusyDay, stuckInCrowd, crowdPenalty,
    pairZoneDistance, prescribe, computeTargetRegions, FOCUSES, PROGRAM_DAYS,
    PROGRAM_SEQUENCE, programSequence, nextProgramDay, dayNumber, mesocycleWeek, MESO,
    dayMuscleRegions, sessionMuscleRegions,
    macrocycleWeek, macroBlockIndex, macroBlockKey, BLOCK_KEYS, BLOCK_NAMES, MACRO_BLOCKS, slotScheme,
    isTestWeek, estimate1RM, TEST_MAIN_SCHEME,
    weeklySets, parseSets, VOLUME_TARGETS,
  };
}

// ============================================================================
// Browser UI
// ============================================================================
if (typeof document !== "undefined") {
  const STORE_KEY = "wgen.state.v1";
  const APP_VERSION = "v17"; // keep in sync with CACHE in service-worker.js; bump on each deploy
  let DATA = { movements: [], gym: {} };
  let STATE = loadState();
  let CURRENT = null; // current generated session

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { history: [], maxes: {}, progress: {}, slots: {}, logs: [], program: { daysPerWeek: 6, logged: 0 }, settings: { bars: { him: "mens", her: "womens" } }, avoidList: [] };
  }
  function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(STATE)); }
  function todayStr() { const d = new Date(); return d.toISOString().slice(0, 10); }

  async function boot() {
    try {
      const [mv, gym] = await Promise.all([
        fetch("movements.json").then((r) => r.json()),
        fetch("gym.json").then((r) => r.json()),
      ]);
      DATA = { movements: mv.movements, gym };
    } catch (e) {
      document.getElementById("app").innerHTML = "<p class='err'>Could not load data files. Serve this folder over http (see README).</p>";
      return;
    }
    STATE.program = STATE.program || { daysPerWeek: 6, logged: 0 };
    STATE.slots = STATE.slots || {};
    STATE.logs = STATE.logs || [];
    renderProgram();
    renderWeek();
    renderFocusPicker();
    wireButtons();
    renderVersion(false);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").then((reg) => {
        // When a newer deploy is installed, tell the user this screen is now stale.
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (nw) nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) renderVersion(true);
          });
        });
      }).catch(() => {});
    }
  }

  // Version stamp at the bottom of the screen so you can tell if this is the latest deploy.
  function renderVersion(updateReady) {
    const el = document.getElementById("version");
    if (!el) return;
    el.textContent = updateReady ? `${APP_VERSION} · update ready — tap to refresh` : APP_VERSION;
    el.classList.toggle("update", !!updateReady);
    el.onclick = updateReady ? () => location.reload() : null;
  }

  function wireButtons() {
    document.getElementById("genBtn").onclick = () => generate(currentFocusChoice());
    document.getElementById("logBtn").onclick = () => logSession();
    document.getElementById("exportBtn").onclick = () => exportData();
    document.getElementById("importInput").onchange = (e) => importData(e);
    document.getElementById("avoidedBtn").onclick = () => renderAvoided();
    document.getElementById("progressBtn").onclick = () => renderProgress();
  }

  function generate(choice) {
    const seed = (Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 1e9);
    const base = { today: todayStr(), history: STATE.history, maxes: STATE.maxes, progress: STATE.progress || {}, slots: STATE.slots || {}, settings: STATE.settings, avoidList: STATE.avoidList, seed };
    if (choice && PROGRAM_DAYS[choice]) {
      CURRENT = buildProgramSession(DATA, Object.assign({ day: choice, mesoWeek: mesocycleWeek(STATE.program), macroBlock: macroBlockKey(STATE.program) }, base));
    } else {
      // Freestyle CrossFit-style: a legacy focus name, or undefined for auto.
      CURRENT = buildSession(DATA, Object.assign({ focusOverride: (choice && FOCUSES[choice]) ? choice : undefined }, base));
    }
    renderSession();
  }

  function renderProgram() {
    const el = document.getElementById("program");
    const prog = STATE.program;
    const day = nextProgramDay(prog, STATE.history, todayStr());
    const seqDay = programSequence(prog.daysPerWeek)[(prog.logged || 0) % programSequence(prog.daysPerWeek).length];
    const skipped = day !== seqDay; // reordered to avoid repeating yesterday's body parts
    const wk = mesocycleWeek(prog);
    const seqLen = programSequence(prog.daysPerWeek).length;
    const meso = MESO[wk];
    const macroWk = macrocycleWeek(prog);
    const blockIdx = macroBlockIndex(prog);
    const blockName = BLOCK_NAMES[macroBlockKey(prog)];
    const testWk = isTestWeek(macroBlockKey(prog), wk);
    el.innerHTML =
      `<h2>Your program</h2>` +
      `<p class="path">Balanced Hypertrophy + Fitness · Macro Week ${macroWk}/12</p>` +
      `<p><b>Block ${blockIdx + 1}/3:</b> ${blockName}</p>` +
      `<p>Meso Week ${wk}/4 (${meso.name}${meso.deload ? " — take it easy" : ""}) · Day ${dayNumber(prog)} of ${seqLen}</p>` +
      (testWk ? `<p class="testnote">🏋 <b>Test week:</b> optional clean <b>3RM</b> on strength-day main lifts (not a true max). Logging it updates your estimated 1RM. Everything else stays deload.</p>` : "") +
      `<p><b>Next:</b> ${day}${skipped ? ` <span class="last">(moved up — ${seqDay} repeats yesterday's body parts)</span>` : ""}</p>` +
      `<button id="nextBtn" class="primary">Generate Next Workout</button>` +
      `<div class="dpw">Training days/week: ` +
      `<button class="dpwbtn ${prog.daysPerWeek === 6 ? "on" : ""}" data-d="6">6</button>` +
      `<button class="dpwbtn ${prog.daysPerWeek === 7 ? "on" : ""}" data-d="7">7</button></div>`;
    document.getElementById("nextBtn").onclick = () => generate(day);
    el.querySelectorAll(".dpwbtn").forEach((b) => b.onclick = () => {
      STATE.program.daysPerWeek = +b.dataset.d; saveState(); renderProgram();
    });
  }

  function renderWeek() {
    const el = document.getElementById("week");
    const { patternFatigue } = computeFatigue(STATE.history, todayStr());
    const recent = STATE.history.filter((s) => daysBetween(s.date, todayStr()) <= 7);
    const fresh = ["squat", "hinge", "lunge", "h-push", "v-push", "h-pull", "v-pull", "core", "conditioning"]
      .map((p) => [p, freshness(p, patternFatigue)]).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
    const vol = weeklySets(STATE.history, todayStr());
    const volRows = Object.keys(vol.targets).map((k) =>
      `<span class="volcell">${k} <b>${vol.sets[k]}</b>/${vol.targets[k]}</span>`).join("");
    el.innerHTML =
      `<h2>This week so far</h2>` +
      `<p>${recent.length} session(s) · cardio exposures: ${vol.cardioExposures}/3</p>` +
      `<p><b>Freshest:</b> ${fresh.join(", ")}</p>` +
      `<div class="vol"><div class="vollabel">Working sets per muscle (last 7 days)</div><div class="volgrid">${volRows}</div></div>`;
  }

  function currentFocusChoice() {
    const sel = document.getElementById("focusSelect");
    return sel && sel.value ? sel.value : undefined; // undefined = Auto (freshest)
  }

  function renderFocusPicker() {
    const sel = document.getElementById("focusSelect");
    const program = Object.keys(PROGRAM_DAYS).map((d) => `<option value="${d}">${d}</option>`).join("");
    const freestyle = `<option value="">Auto (freshest)</option>` +
      Object.keys(FOCUSES).map((f) => `<option value="${f}">${f}</option>`).join("");
    sel.innerHTML =
      `<optgroup label="Program (prescriptive split)">${program}</optgroup>` +
      `<optgroup label="Freestyle (CrossFit-style)">${freestyle}</optgroup>`;
    // Restore the last chosen workout so it sticks across reloads.
    sel.value = (STATE.settings && STATE.settings.lastFocus) || "";
    sel.onchange = () => {
      STATE.settings = STATE.settings || {};
      STATE.settings.lastFocus = sel.value;
      saveState();
      generate(sel.value || undefined);
    };
  }

  function renderSession() {
    const el = document.getElementById("session");
    if (!CURRENT) { el.innerHTML = ""; return; }
    const pathStr = CURRENT.zonePath.map((z) => `${z}·${DATA.gym.zones[z].name}`).join("  →  ");
    const crowd = DATA.gym.crowd;
    const busy = crowd && isBusyDay(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(todayStr() + "T00:00:00").getDay()], crowd);
    const busyNote = busy ? `<div class="testnote">🚦 Busy day — steering away from the crowded ${(crowd.crowdedZones || []).map((z) => `Zone ${z}`).join("/")} (bench/DB end) toward the rigs &amp; machines.</div>` : "";
    let html = `<div class="sesshead"><h2>${CURRENT.focus}</h2><div class="path">Path: ${pathStr}</div>${busyNote}</div>`;
    CURRENT.blocks.forEach((bk, bi) => {
      const zoneTag = bk.zone ? `<span class="zone">Zone ${bk.zone} — ${bk.zoneName}</span>` : `<span class="zone">moves span zones</span>`;
      html += `<div class="block"><div class="bhead"><h3>${bk.name}</h3><span class="time">${bk.time || ""}</span></div>`;
      html += `<div class="bstruct">${bk.structure || ""} ${zoneTag}</div>`;
      bk.items.forEach((it, ii) => {
        html += `<div class="move" data-bi="${bi}" data-ii="${ii}">`;
        html += `<div class="mname">${it.movement.name} <span class="muscles">${(it.movement.muscles || []).join(" · ")}</span></div>`;
        const mz = (it.movement.zones || []).join("/");
        html += `<div class="mpresc">${it.prescription || ""}${mz ? ` <span class="mzone">Zone ${mz}</span>` : ""}</div>`;
        if (it.load) {
          const lastH = it.load.him.last ? `<span class="last">${it.load.him.last}</span>` : "";
          const lastR = it.load.her.last ? `<span class="last">${it.load.her.last}</span>` : "";
          html += `<div class="loads">` +
            `<span class="loadedit" data-bi="${bi}" data-ii="${ii}" data-who="him">You: <b>${it.load.him.display}</b> ${lastH} ✎</span>` +
            `<span class="loadedit" data-bi="${bi}" data-ii="${ii}" data-who="her">Her: <b>${it.load.her.display}</b> ${lastR} ✎</span>` +
            `</div>`;
        } else if (trackingType(it.movement) === "time") {
          const hs = holdSuggestion(it.movement, parseTargetSeconds(it.prescription), STATE.progress);
          if (hs) {
            const lh = hs.him.last ? `<span class="last">${hs.him.last}</span>` : "";
            const lr = hs.her.last ? `<span class="last">${hs.her.last}</span>` : "";
            html += `<div class="loads"><span>You: <b>${hs.him.display}</b> ${lh}</span><span>Her: <b>${hs.her.display}</b> ${lr}</span></div>`;
          }
        }
        html += `<div class="mactions"><button class="swap" data-bi="${bi}" data-ii="${ii}">Swap</button><button class="avoid" data-bi="${bi}" data-ii="${ii}">Don't suggest</button></div>`;
        html += `</div>`;
      });
      html += `</div>`;
    });
    el.innerHTML = html;
    el.querySelectorAll("button.swap").forEach((b) => b.onclick = () => swapMove(+b.dataset.bi, +b.dataset.ii));
    el.querySelectorAll("button.avoid").forEach((b) => b.onclick = () => avoidMove(+b.dataset.bi, +b.dataset.ii));
    el.querySelectorAll(".loadedit").forEach((s) => s.onclick = () => editLoad(+s.dataset.bi, +s.dataset.ii, s.dataset.who));
    document.getElementById("logBtn").disabled = false;
  }

  function swapMove(bi, ii) {
    const item = CURRENT.blocks[bi].items[ii];
    const role = CURRENT.blocks[bi].role || blockRole(CURRENT.blocks[bi].name);
    let cands = swapCandidates(DATA, item.movement, {
      today: todayStr(), history: STATE.history, avoidList: STATE.avoidList,
    }).filter((m) => !sessionMovementIds().includes(m.id));
    // In program mode, keep swaps within the conventional pool too.
    if (CURRENT.mode === "program") cands = cands.filter((m) => m.programDefault !== false);
    if (!cands.length) { alert("No same-region alternative available."); return; }
    const next = cands[0];
    const slot = slotForRole(role);
    const reps = slot === "strength1" ? 3 : (next.pattern === "core" ? 12 : 10);
    CURRENT.blocks[bi].items[ii] = {
      movement: next,
      // Keep the main-lift scheme on S1 swaps; otherwise recompute (handles time/distance moves).
      prescription: slot === "strength1" ? item.prescription : prescribe(next, slot, Math.random),
      load: loadSuggestion(next, reps, STATE.maxes, STATE.settings, DATA.gym.inventory, STATE.progress || {}),
      slotKey: item.slotKey, // keep the slot so logging records the swapped movement for next time
    };
    assignZones(DATA.gym, CURRENT.blocks);
    CURRENT.zonePath = CURRENT.blocks.map((b) => b.zone).filter((z, i, a) => z && (i === 0 || z !== a[i - 1]));
    renderSession();
  }

  function sessionMovementIds() {
    return CURRENT.blocks.flatMap((b) => b.items.map((i) => i.movement.id));
  }

  function avoidMove(bi, ii) {
    const id = CURRENT.blocks[bi].items[ii].movement.id;
    if (!STATE.avoidList.includes(id)) STATE.avoidList.push(id);
    saveState();
    swapMove(bi, ii);
  }

  function renderAvoided() {
    const el = document.getElementById("session");
    if (!STATE.avoidList.length) { el.innerHTML = "<p>No avoided movements.</p>"; return; }
    el.innerHTML = "<h2>Avoided movements</h2>" + STATE.avoidList.map((id) => {
      const m = DATA.movements.find((x) => x.id === id);
      return `<div class="move"><div class="mname">${m ? m.name : id}</div><button data-id="${id}" class="unavoid">Allow again</button></div>`;
    }).join("");
    el.querySelectorAll("button.unavoid").forEach((b) => b.onclick = () => {
      STATE.avoidList = STATE.avoidList.filter((x) => x !== b.dataset.id); saveState(); renderAvoided();
    });
  }

  // Per-person progress dashboard built from the logged history (STATE.logs).
  let PROGRESS_WHO = "him";
  function renderProgress() {
    const el = document.getElementById("session");
    const logs = (STATE.logs || []).filter((l) => l.who === PROGRESS_WHO);
    const toggle =
      `<div class="dpw">Show: ` +
      `<button class="dpwbtn ${PROGRESS_WHO === "him" ? "on" : ""}" data-w="him">You</button>` +
      `<button class="dpwbtn ${PROGRESS_WHO === "her" ? "on" : ""}" data-w="her">Her</button></div>`;
    let body;
    if (!logs.length) {
      body = `<p>No logged sets yet for ${PROGRESS_WHO === "him" ? "you" : "her"}. Log a session to start tracking.</p>`;
    } else {
      // Group newest-first logs by movement.
      const byMv = {};
      logs.forEach((l) => { (byMv[l.movementId] = byMv[l.movementId] || []).push(l); });
      const cards = Object.keys(byMv).map((id) => {
        const entries = byMv[id]; // already newest-first
        const s = summarizeMovementLogs(entries);
        const mv = DATA.movements.find((x) => x.id === id);
        const name = (mv && mv.name) || (entries[0] && entries[0].name) || id;
        const last = s.last;
        const slot = last.slotKey ? last.slotKey.split("::").slice(0, 2).join(" · ") : "";
        const e1rm = STATE.maxes[id] && STATE.maxes[id][PROGRESS_WHO];
        let lastStr;
        if (last.trackingType === "time") lastStr = last.seconds != null ? `${last.seconds}s` : "done";
        else if (last.top != null || last.load != null) {
          const topPart = last.top != null && last.top !== last.load ? `top ${last.top} · ` : "";
          lastStr = `${topPart}${last.load != null ? last.load + " lb" : "done"}${last.rpe != null ? ` @RPE ${last.rpe}` : ""}`;
        } else lastStr = last.status;
        const tags = (last.status !== "done" ? ` <span class="ptag">${last.status}</span>` : "") +
          (last.source === "assumed" ? ` <span class="ptag assumed">assumed</span>` : "");
        const bestStr = s.best ? (s.best.seconds != null ? `${s.best.seconds}s` : `${s.best.load} lb`) : "—";
        return `<div class="pcard"><div class="mname">${name}</div>` +
          (slot ? `<div class="pslot">${slot}</div>` : "") +
          `<div class="prow">Last: <b>${lastStr}</b>${tags} <span class="pdim">${last.date}</span></div>` +
          `<div class="prow">Best: <b>${bestStr}</b>${e1rm ? ` · e1RM <b>${e1rm}</b>` : ""} · ${s.sessions} session${s.sessions > 1 ? "s" : ""}</div>` +
          `</div>`;
      }).join("");
      body = cards;
    }
    el.innerHTML = `<div class="card"><h2>Progress</h2>${toggle}${body}<div class="footer"><button id="progBack">Back</button></div></div>`;
    el.querySelectorAll(".dpwbtn").forEach((b) => b.onclick = () => { PROGRESS_WHO = b.dataset.w; renderProgress(); });
    document.getElementById("progBack").onclick = () => renderSession();
  }

  // Tap a load to set the weight you'll actually use (snapped to loadable). Stored as your
  // working weight so future sessions remember and progress it.
  function editLoad(bi, ii, who) {
    const it = CURRENT.blocks[bi].items[ii];
    if (!it.load) return;
    const mv = it.movement;
    const cur = it.load[who].valueLb || "";
    const val = parseFloat(prompt(`${mv.name} — ${who === "him" ? "your" : "her"} weight (lb):`, cur));
    if (!val || val <= 0) return;
    const barKg = STATE.settings.bars && STATE.settings.bars[who] === "womens" ? DATA.gym.inventory.barbells.womens_kg : DATA.gym.inventory.barbells.mens_kg;
    const snapped = roundLoad(val, mv.implement, DATA.gym.inventory, barKg) || { display: val + " lb", valueLb: val };
    it.load[who] = { display: snapped.display, valueLb: snapped.valueLb, last: it.load[who].last };
    // Remember as working weight (hold next time until RPE says otherwise).
    STATE.progress = STATE.progress || {};
    STATE.progress[mv.id] = STATE.progress[mv.id] || {};
    // Setting a weight by hand means "use this next time" — hold here (rpe cleared), not progress.
    STATE.progress[mv.id][who] = Object.assign({}, STATE.progress[mv.id][who] || {}, { load: snapped.valueLb, rpe: null, completed: true, status: "done", source: "measured" });
    saveState();
    renderSession();
  }

  const RPE_OPTS = `<option value="" selected>RPE —</option>` + [6, 7, 8, 9, 10].map((n) => `<option value="${n}">RPE ${n}</option>`).join("");
  const STATUS_OPTS = `<option value="done" selected>Done</option><option value="partial">Partial</option><option value="skipped">Skipped</option>`;

  // Log flow: capture what you actually did per person, then save. Blank = "completed as
  // prescribed" (assumed → progression holds); entered values are measured. Handles weight+reps
  // (with same-weight vs per-set), timed holds, and Done/Partial/Skipped. See Discussion.md.
  function logSession() {
    if (!CURRENT) return;
    const el = document.getElementById("session");
    // Loggable = everything except warm-up / mobility filler.
    const rows = [];
    CURRENT.blocks.forEach((b, bi) => {
      const role = b.role || "";
      b.items.forEach((it, ii) => {
        if (role === "warmup" || role === "mobility" || it.movement.pattern === "mobility") return;
        rows.push({ bi, ii, it, tt: trackingType(it.movement) });
      });
    });

    const personFields = (it, tt, who) => {
      if (tt === "load_reps" && it.load) {
        const init = it.load[who].valueLb;
        const initAttr = init != null ? init : "";
        const n = Math.min(6, Math.max(1, parseSets(it.prescription) || 3));
        let setRows = "";
        for (let i = 0; i < n; i++) setRows += `<div class="lgset">Set ${i + 1} <input type="number" step="0.5" class="lgsetw" placeholder="${initAttr}"> lb × <input type="number" class="lgsetr" placeholder="reps"></div>`;
        return `<label class="cb">same wt <input type="checkbox" class="lgsame" checked></label>` +
          `<span class="lgsimple"><input type="number" step="0.5" class="lgw" value="${initAttr}" data-init="${initAttr}"> lb</span>` +
          `<div class="lgadv" hidden>${setRows}</div>` +
          `<select class="lgr">${RPE_OPTS}</select>`;
      }
      if (tt === "time") {
        const tgt = parseTargetSeconds(it.prescription);
        return `<span class="lgtime">target <b>${tgt != null ? tgt + "s" : "—"}</b> · held <input type="number" class="lgsec" placeholder="${tgt != null ? tgt : ""}"> s</span>`;
      }
      return ``; // distance/cardio/reps: status only
    };
    const personRow = (it, tt, who, label) =>
      `<div class="logperson" data-who="${who}">${label} <select class="lgstatus">${STATUS_OPTS}</select> ${personFields(it, tt, who)}</div>`;

    let html = `<div class="card"><h2>Log: ${CURRENT.focus}</h2><p class="path">Leave blank = done as prescribed. Enter actuals to log details. RPE 6 easy → 10 max.</p>`;
    rows.forEach((R, k) => {
      html += `<div class="logrow" data-k="${k}"><div class="mname">${R.it.movement.name} <span class="lgpresc">${R.it.prescription || ""}</span></div>` +
        personRow(R.it, R.tt, "him", "You") + personRow(R.it, R.tt, "her", "Her") + `</div>`;
    });
    if (!rows.length) html += `<p>Nothing to track here. Just save to record the session.</p>`;
    html += `<div class="footer"><button id="logSave" class="primary">Save</button><button id="logCancel">Cancel</button></div></div>`;
    el.innerHTML = html;
    // Toggle per-set rows when "same wt" is unchecked.
    el.querySelectorAll(".lgsame").forEach((cb) => cb.onchange = () => {
      const pr = cb.closest(".logperson");
      pr.querySelector(".lgsimple").hidden = !cb.checked;
      pr.querySelector(".lgadv").hidden = cb.checked;
    });
    document.getElementById("logCancel").onclick = () => renderSession();
    document.getElementById("logSave").onclick = () => doLogSave(el, rows);
  }

  function parsePersonRow(pr, it, tt) {
    const status = pr.querySelector(".lgstatus").value;
    if (tt === "load_reps" && it.load) {
      const rpeRaw = pr.querySelector(".lgr").value;
      const rpe = rpeRaw ? parseInt(rpeRaw, 10) : null;
      const same = pr.querySelector(".lgsame").checked;
      let sets = [], touched = false;
      if (same) {
        const wEl = pr.querySelector(".lgw");
        const w = parseFloat(wEl.value), init = parseFloat(wEl.dataset.init);
        if (w > 0) sets = [{ load: w }];
        if (w > 0 && !(init > 0 && Math.abs(w - init) < 1e-9)) touched = true;
      } else {
        pr.querySelectorAll(".lgset").forEach((sr) => {
          const w = parseFloat(sr.querySelector(".lgsetw").value), r = parseFloat(sr.querySelector(".lgsetr").value);
          if (w > 0) { sets.push({ load: w, reps: r > 0 ? r : null }); touched = true; }
        });
        if (!sets.length) { const init = parseFloat(pr.querySelector(".lgw").dataset.init); if (init > 0) sets = [{ load: init }]; }
      }
      const anyEntered = touched || rpe != null || status !== "done";
      return { anyEntered, raw: { trackingType: "load_reps", status, rpe, sets, anyEntered, date: todayStr() } };
    }
    if (tt === "time") {
      const secs = parseFloat(pr.querySelector(".lgsec").value);
      const tgt = parseTargetSeconds(it.prescription);
      const anyEntered = secs > 0 || status !== "done";
      return { anyEntered, raw: { trackingType: "time", status, seconds: secs > 0 ? secs : null, targetSeconds: tgt != null ? tgt : null, anyEntered, date: todayStr() } };
    }
    const anyEntered = status !== "done";
    return { anyEntered, raw: { trackingType: tt, status, anyEntered, date: todayStr() } };
  }

  function doLogSave(el, rows) {
    const today = todayStr();
    // First pass: parse every person row so we can warn about mixed blank/filled logs.
    const entries = [];
    el.querySelectorAll(".logrow").forEach((row) => {
      const R = rows[+row.dataset.k];
      row.querySelectorAll(".logperson").forEach((pr) => {
        const parsed = parsePersonRow(pr, R.it, R.tt);
        entries.push({ R, who: pr.dataset.who, anyEntered: parsed.anyEntered, rec: summarizePerf(parsed.raw) });
      });
    });
    const someMeasured = entries.some((e) => e.anyEntered), someAssumed = entries.some((e) => !e.anyEntered);
    if (someMeasured && someAssumed &&
      !confirm("Some entries are blank. They'll be logged as completed as prescribed using the suggested weights.\n\nLog anyway?")) return;

    STATE.progress = STATE.progress || {}; STATE.maxes = STATE.maxes || {}; STATE.logs = STATE.logs || [];
    entries.forEach(({ R, who, rec }) => {
      const mv = R.it.movement;
      STATE.progress[mv.id] = STATE.progress[mv.id] || {};
      // Merge: keep prior load/seconds when none were entered, but always update status/source/rpe
      // so an assumed or partial log progresses conservatively next time.
      STATE.progress[mv.id][who] = Object.assign({}, STATE.progress[mv.id][who] || {}, rec, { date: today });
      if (R.it.test && rec.status === "done" && rec.top > 0) {
        STATE.maxes[mv.id] = STATE.maxes[mv.id] || {};
        STATE.maxes[mv.id][who] = estimate1RM(rec.top); // 3RM → est 1RM
      }
      STATE.logs.unshift({
        date: today, movementId: mv.id, name: mv.name, who, slotKey: R.it.slotKey || null,
        trackingType: rec.trackingType, status: rec.status, source: rec.source, rpe: rec.rpe,
        load: rec.load != null ? rec.load : null, top: rec.top != null ? rec.top : null,
        sets: rec.sets || null, seconds: rec.seconds != null ? rec.seconds : null,
        targetSeconds: rec.targetSeconds != null ? rec.targetSeconds : null,
      });
    });

    STATE.history.unshift(sessionToHistoryEntry(CURRENT)); // newest-first, for fatigue/volume
    STATE.slots = STATE.slots || {};
    CURRENT.blocks.forEach((b) => b.items.forEach((it) => { if (it.slotKey) STATE.slots[it.slotKey] = it.movement.id; }));
    let advanced = "";
    if (CURRENT.mode === "program") {
      STATE.program = STATE.program || { daysPerWeek: 6, logged: 0 };
      STATE.program.logged = (STATE.program.logged || 0) + 1;
      advanced = ` Up next: ${nextProgramDay(STATE.program, STATE.history, todayStr())}.`;
    }
    saveState();
    renderProgram();
    renderWeek();
    el.innerHTML = `<div class="card"><h2>Logged ✓</h2><p>Nice work. Suggestions will adjust from what you logged.${advanced}</p><button id="seeProgress">See progress</button></div>`;
    document.getElementById("seeProgress").onclick = () => renderProgress();
    document.getElementById("logBtn").disabled = true;
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `workout-data-${todayStr()}.json`;
    a.click();
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        STATE = JSON.parse(reader.result);
        STATE.program = STATE.program || { daysPerWeek: 6, logged: 0 };
        STATE.slots = STATE.slots || {};
        STATE.progress = STATE.progress || {};
        STATE.logs = STATE.logs || [];
        saveState();
        CURRENT = null;
        renderProgram(); renderWeek(); renderFocusPicker(); renderSession();
        alert("Imported.");
      } catch (err) { alert("Bad file."); }
    };
    reader.readAsText(file);
  }

  window.addEventListener("DOMContentLoaded", boot);
}
