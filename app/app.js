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
  squat: "lower", hinge: "lower", lunge: "lower",
  "h-push": "push", "v-push": "push", "h-pull": "pull", "v-pull": "pull",
  olympic: "full", carry: "full", core: "core", conditioning: "cardio", mobility: "full",
};

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
  if (slot === "warmup") return "x8–10 (light)";
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

// Build the his/hers load suggestion for a loadable movement at a rep target.
function loadSuggestion(movement, reps, maxes, settings, inv) {
  if (!movement.loadable) return null;
  const pct = pctForReps(reps);
  const out = {};
  for (const who of ["him", "her"]) {
    const e1rm = maxes[movement.id] ? maxes[movement.id][who] : null;
    const barKg = settings.bars && settings.bars[who] === "womens" ? inv.barbells.womens_kg : inv.barbells.mens_kg;
    if (!e1rm) { out[who] = { display: "set 1RM", valueLb: null }; continue; }
    const target = e1rm * pct;
    out[who] = roundLoad(target, movement.implement, inv, barKg) || { display: `${Math.round(target)} lb`, valueLb: Math.round(target) };
  }
  return { pct, ...out };
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
  const inv = gym.inventory;
  const rng = makeRng(opts.seed || 1);

  const focus = pickFocus(history, today, opts.focusOverride, rng);
  const cfg = FOCUSES[focus];
  const { patternFatigue, muscleFatigue } = computeFatigue(history, today);
  const bias = balanceBias(history, today);
  const pool = filterCandidates(movements, { today, history, avoidList: opts.avoidList || [] });

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
  const mobScore = (m) => 1 + ((targetRegions.has(m.region) || m.region === "full") ? 0.8 : 0);
  let mobPool = warmMob.slice();
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
    const s1 = pickWeighted(s1cands, (m) => scoreByFreshness(m, patternFatigue, (mm) => {
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
        items: [{ movement: s1, prescription: presc, load: loadSuggestion(s1, reps, maxes, settings, inv) }],
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
        pairs.push({ a: ca, b: cb, score: scoreByFreshness(ca, patternFatigue, pushPullBias) + scoreByFreshness(cb, patternFatigue) + zoneBonus });
      }
    }
    if (pairs.length) {
      const chosen = pickWeighted(pairs, (p) => p.score, rng);
      a = chosen.a; b = chosen.b;
    } else if (aCands.length) {
      // No zone-compatible partner — run the accessory solo rather than make them walk.
      a = pickWeighted(aCands, (m) => scoreByFreshness(m, patternFatigue, pushPullBias), rng);
    }
    const s2items = [];
    if (a) { s2items.push({ movement: a, prescription: "4×8 @ RPE 8", load: loadSuggestion(a, 8, maxes, settings, inv) }); note(a.id); (a.muscles || []).forEach((m) => usedMuscles.add(m)); }
    if (b) { s2items.push({ movement: b, prescription: prescribe(b, "strength2", rng), load: loadSuggestion(b, 12, maxes, settings, inv) }); note(b.id); (b.muscles || []).forEach((m) => usedMuscles.add(m)); }
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
    const c = pickWeighted(freshCardio.length ? freshCardio : cardioCands, (m) => scoreByFreshness(m, patternFatigue), rng);
    metItems.push({ movement: c, prescription: prescribe(c, "metcon", rng) }); note(c.id);
  }
  const used = new Set(metItems.map((i) => i.movement.id));
  let pickPool = moveCands.filter((m) => !used.has(m.id));
  for (let i = metItems.length; i < metconN && pickPool.length; i++) {
    const m = pickWeighted(pickPool, (mm) => scoreByFreshness(mm, patternFatigue, muscleAvoid) + 0.3, rng);
    metItems.push({ movement: m, prescription: prescribe(m, "metcon", rng) });
    used.add(m.id);
    pickPool = pickPool.filter((x) => x.id !== m.id);
  }
  blocks.push({ name: "MetCon", time: `~${struct.minutes} min`, structure: struct.detail, items: metItems });

  // --- Zone assignment + path ---------------------------------------------
  assignZones(gym, blocks);
  const path = blocks.map((bk) => bk.zone).filter((z, i, arr) => z && (i === 0 || z !== arr[i - 1]));

  return { date: today, focus, zonePath: path, blocks, seed: opts.seed || 1 };
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
    const intensity = ROLE_INTENSITY[blockRole(bk.name)] || "light";
    for (const it of bk.items) {
      items.push({ movementId: it.movement.id, pattern: it.movement.pattern, muscles: it.movement.muscles || [], intensity, role: blockRole(bk.name) });
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

// ----------------------------------------------------------------------------
// Swap: find an equivalent movement (same region, compatible role, near zone)
// ----------------------------------------------------------------------------

function swapCandidates(data, currentMovement, role, opts) {
  const { movements, gym } = data;
  const pool = filterCandidates(movements, { today: opts.today, history: opts.history || [], avoidList: opts.avoidList || [] });
  return pool.filter((m) =>
    m.id !== currentMovement.id &&
    m.region === currentMovement.region &&
    m.loadable === currentMovement.loadable &&
    m.cardio === currentMovement.cardio &&
    (m.roles || []).includes(role)
  ).sort((a, b) => pairZoneDistance(gym, currentMovement, a).dist - pairZoneDistance(gym, currentMovement, b).dist);
}

// ----------------------------------------------------------------------------
// Node export (for tests)
// ----------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeFatigue, freshness, balanceBias, filterCandidates, lastUsed,
    pickFocus, buildSession, roundLoad, nearestBarbell, nearestInLadder,
    loadSuggestion, swapCandidates, sessionToHistoryEntry, pctForReps,
    pairZoneDistance, prescribe, computeTargetRegions, FOCUSES,
  };
}

// ============================================================================
// Browser UI
// ============================================================================
if (typeof document !== "undefined") {
  const STORE_KEY = "wgen.state.v1";
  let DATA = { movements: [], gym: {} };
  let STATE = loadState();
  let CURRENT = null; // current generated session

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { history: [], maxes: {}, settings: { bars: { him: "mens", her: "womens" } }, avoidList: [] };
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
    renderWeek();
    renderFocusPicker();
    wireButtons();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }

  function wireButtons() {
    document.getElementById("genBtn").onclick = () => generate(currentFocusChoice());
    document.getElementById("logBtn").onclick = () => logSession();
    document.getElementById("exportBtn").onclick = () => exportData();
    document.getElementById("importInput").onchange = (e) => importData(e);
    document.getElementById("avoidedBtn").onclick = () => renderAvoided();
  }

  function generate(focusOverride) {
    const seed = (Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 1e9);
    CURRENT = buildSession(DATA, {
      today: todayStr(),
      history: STATE.history,
      maxes: STATE.maxes,
      settings: STATE.settings,
      avoidList: STATE.avoidList,
      focusOverride,
      seed,
    });
    renderSession();
  }

  function renderWeek() {
    const el = document.getElementById("week");
    const { patternFatigue } = computeFatigue(STATE.history, todayStr());
    const recent = STATE.history.filter((s) => daysBetween(s.date, todayStr()) <= 7);
    const fatigued = Object.entries(patternFatigue).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
    const fresh = ["squat", "hinge", "lunge", "h-push", "v-push", "h-pull", "v-pull", "core", "conditioning"]
      .map((p) => [p, freshness(p, patternFatigue)]).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
    el.innerHTML =
      `<h2>This week so far</h2>` +
      `<p>${recent.length} session(s) in the last 7 days.</p>` +
      `<p><b>Worked recently:</b> ${fatigued.length ? fatigued.join(", ") : "—"}</p>` +
      `<p><b>Freshest:</b> ${fresh.join(", ")}</p>`;
  }

  function currentFocusChoice() {
    const sel = document.getElementById("focusSelect");
    return sel && sel.value ? sel.value : undefined; // undefined = Auto (freshest)
  }

  function renderFocusPicker() {
    const sel = document.getElementById("focusSelect");
    sel.innerHTML = `<option value="">Auto (freshest)</option>` +
      Object.keys(FOCUSES).map((f) => `<option value="${f}">${f}</option>`).join("");
    // Restore the last chosen category so it sticks across reloads.
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
    let html = `<div class="sesshead"><h2>${CURRENT.focus}</h2><div class="path">Path: ${pathStr}</div></div>`;
    CURRENT.blocks.forEach((bk, bi) => {
      const zoneTag = bk.zone ? `<span class="zone">Zone ${bk.zone} — ${bk.zoneName}</span>` : "";
      html += `<div class="block"><div class="bhead"><h3>${bk.name}</h3><span class="time">${bk.time}</span></div>`;
      html += `<div class="bstruct">${bk.structure} ${zoneTag}</div>`;
      bk.items.forEach((it, ii) => {
        html += `<div class="move" data-bi="${bi}" data-ii="${ii}">`;
        html += `<div class="mname">${it.movement.name} <span class="muscles">${(it.movement.muscles || []).join(" · ")}</span></div>`;
        const mz = (it.movement.zones || []).join("/");
        html += `<div class="mpresc">${it.prescription || ""}${mz ? ` <span class="mzone">Zone ${mz}</span>` : ""}</div>`;
        if (it.load) {
          html += `<div class="loads"><span>You: <b>${it.load.him.display}</b></span><span>Her: <b>${it.load.her.display}</b></span></div>`;
        }
        html += `<div class="mactions"><button class="swap" data-bi="${bi}" data-ii="${ii}">Swap</button><button class="avoid" data-bi="${bi}" data-ii="${ii}">Don't suggest</button></div>`;
        html += `</div>`;
      });
      html += `</div>`;
    });
    el.innerHTML = html;
    el.querySelectorAll("button.swap").forEach((b) => b.onclick = () => swapMove(+b.dataset.bi, +b.dataset.ii));
    el.querySelectorAll("button.avoid").forEach((b) => b.onclick = () => avoidMove(+b.dataset.bi, +b.dataset.ii));
    document.getElementById("logBtn").disabled = false;
  }

  function swapMove(bi, ii) {
    const item = CURRENT.blocks[bi].items[ii];
    const role = blockRole(CURRENT.blocks[bi].name);
    const cands = swapCandidates(DATA, item.movement, role === "warmup" ? "warmup" : (role === "metcon" ? "metcon" : "strength2"), {
      today: todayStr(), history: STATE.history, avoidList: STATE.avoidList,
    }).filter((m) => !sessionMovementIds().includes(m.id));
    if (!cands.length) { alert("No same-region alternative available."); return; }
    const next = cands[0];
    const slot = role === "warmup" ? "warmup" : (role === "metcon" ? "metcon" : (role === "strength1" ? "strength1" : "strength2"));
    const reps = role === "strength1" ? 3 : (next.pattern === "core" ? 12 : 8);
    CURRENT.blocks[bi].items[ii] = {
      movement: next,
      // Keep the main-lift scheme on S1 swaps; otherwise recompute (handles time/distance moves).
      prescription: slot === "strength1" ? item.prescription : prescribe(next, slot, Math.random),
      load: loadSuggestion(next, reps, STATE.maxes, STATE.settings, DATA.gym.inventory),
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

  function logSession() {
    if (!CURRENT) return;
    const entry = sessionToHistoryEntry(CURRENT);
    STATE.history.unshift(entry); // newest-first
    saveState();
    renderWeek();
    alert("Logged. Nice work!");
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
      try { STATE = JSON.parse(reader.result); saveState(); renderWeek(); alert("Imported."); }
      catch (err) { alert("Bad file."); }
    };
    reader.readAsText(file);
  }

  window.addEventListener("DOMContentLoaded", boot);
}
