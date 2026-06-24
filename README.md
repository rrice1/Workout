# Workout Generator

A phone-friendly **PWA** for two people who train together. It runs a **periodized
strength/hypertrophy program** (a 6–7 day split inside a 4-week wave inside a 12-week macrocycle)
or a **freestyle CrossFit/Hyrox mode**, rotating movement patterns so you don't overwork anything
from earlier in the week. It tracks each person's loads, suggests **his/hers** weights you can
actually load with your gym's equipment, keeps supersets in the same area of the gym, steers
around the **crowded** zones on busy days, and lets you **share** a workout between phones. No app
store, no build, no backend.

## What's here

```
app/
  index.html, app.js, styles.css   # the generator
  movements.json      # tagged movement library (pattern, region, equipment, zones, scheduling)
  gym.json            # your gym's zone map + equipment ladders for load rounding
  manifest.webmanifest, service-worker.js, icon-*.png   # PWA plumbing
  test.js             # node self-check for the generator logic
```

## Run it on your computer

The app loads two JSON files, so it must be served over http (opening `index.html` directly
with `file://` won't work). From this folder:

```bash
cd app
python -m http.server 8000
```

Then open <http://localhost:8000> and use **Generate Next Workout** (program) or **Generate**
(freestyle).

Run the logic self-check with `node app/test.js`.

## Put it on your phones (the real use)

iOS needs **https** for offline mode, so host the `app/` folder with GitHub Pages:

1. In the repo, turn on **Settings → Pages** (deploy from branch). GitHub gives you an
   `https://<you>.github.io/...` URL.
2. Open that URL in **Safari** on each phone → Share → **Add to Home Screen**.
3. It now has its own icon, runs full-screen, and works **offline**.

No App Store, no build, no signing, no expiry. To update later, edit the files and push — bump
both `CACHE` in `service-worker.js` and `APP_VERSION` in `app.js` so the offline cache refreshes
and the version stamp updates. The app shows the current version at the bottom of the screen, and
flips to **"update ready — tap to refresh"** when a newer deploy has been picked up.

## Using it

- **Follow the program (recommended):** the top card shows your next scheduled session —
  e.g. *Week 2/4 · Day 3 of 6 — Pull Strength* — and **Generate Next Workout** builds it. The
  sequence advances **only when you log a program session** (skipping a calendar day doesn't
  skip a workout; freestyle sessions don't advance it). It runs a **4-week wave**: weeks 1–3
  ramp up, week 4 is an automatic **deload** (lighter loads, fewer sets). Toggle **6 vs 7
  training days** (the 7th is an easy Pump / Recovery day, never required). If you trained
  yesterday, the **next workout skips ahead** to a day that doesn't repeat the same major body
  region (push/pull/lower) — e.g. it won't serve Upper Hypertrophy right after a Push day — so you
  don't hit similar body parts two days running. (Conditioning and Pump/Recovery are light enough
  to follow anything.)
- Those 4-week waves sit inside a **12-week macrocycle** of three blocks that change the
  *feel* without changing the split: **Hypertrophy Base** (wk 1–4, mostly 8s), **Strength-Biased
  Hypertrophy** (wk 5–8, mains drop to 5s/4s/3s), then **Fitness / Performance** (wk 9–12,
  moderate 5–8s with more conditioning). Set/rep/RPE per slot come from per-block tables; the
  Upper Hypertrophy day stays hypertrophy-rep even in the strength block, and Pump / Recovery
  stays easy throughout. After week 12 it loops to Block 1 with your progressed weights.
- **Heavy / max work** is scheduled, not random: macro **week 7** (end of the strength block) is
  a heavy-triple exposure (mains at `5×3 @ RPE 8-9`), and **week 8** turns the deload into an
  **optional 3RM test** on each strength day's main lift — *a clean heavy triple, not a true max*
  — with a `2×8` backoff and no finisher. Logging the test updates your **estimated 1RM**
  (≈ 3RM × 1.10) for future percentage-based suggestions. Hypertrophy days and Block 1/3 are
  never turned into tests.
- The **This week so far** card shows **working sets per muscle vs target** and cardio exposures,
  so you can see what's under- or over-trained across the week.
- Or **pick manually** from the dropdown — two families:
  - **Program (prescriptive split):** Push Strength, Lower Strength — Squat, Pull Strength,
    Conditioning + Core, Upper Hypertrophy, Lower Hypertrophy — Hinge, Pump / Recovery. Each day
    has a clear identity, its own block structure, forbidden patterns (e.g. no legs on push day),
    and an intensity cap — built for training 6–7 days/week without frying yourself.
  - **PHAT (fixed template):** Layne Norton's *Power Hypertrophy Adaptive Training* — Upper Power,
    Lower Power, Back & Shoulders Hypertrophy, Lower Hypertrophy, Chest & Arms Hypertrophy (Day 3
    is rest). Unlike the dynamic program these are **set in stone** — the exact exercises and
    sets/reps every time — but you can still **swap** any movement (the swap sticks), log weights
    (including on machines/cables), and share/save it. Pick the day from the dropdown.
  - **Arnold Volume (fixed template):** the classic high-volume golden-era split, in **two
    variations** you can mix and match. **Variation 1** is a 3-day rotation run twice a week —
    *Chest & Back, Shoulders & Arms, Legs & Lower Back* (mostly 3–4 × 10). **Variation 2** is the
    brutal 2-day rotation run three times a week — *Chest, Back & Legs* and *Shoulders & Arms*
    (5–6 sets per exercise, often to failure). Like PHAT these are **set in stone** but fully
    swap/log/share-able; pick any day from the dropdown for an ad-hoc session.
  - **Reddit PPL (fixed template):** the popular r/Fitness *Metallicadpa* linear-progression
    Push/Pull/Legs for beginners, run 6 days a week (PPLxPPL). Push, Pull, and Legs each have a
    **main barbell lift you add weight to every session** (last set AMRAP) plus accessories in the
    8–12 range (double progression). The program's weekly **A/B alternation** is split into pickable
    days — *Pull (Deadlift)* vs *Pull (Barbell Row)*, *Push (Bench)* vs *Push (OHP)*, and *Legs* —
    so you just choose the right one each session. Like the other fixed templates it's
    swap/log/share/save-able, and machine accessories still track their weight.
  - **StrongLifts 5×5 (fixed template):** the classic 3-day full-body beginner barbell program.
    Two alternating workouts — **A** (Squat / Bench / Barbell Row) and **B** (Squat / Overhead
    Press / Deadlift) — run M/W/F as ABA then BAB. Everything is 5×5 (deadlift 1×5); add weight
    every session and the per-set logger remembers it. The shortest-week option here.
  - **PHUL — Power Hypertrophy Upper Lower (fixed template):** the 4-day sibling of PHAT. Two
    **power** days (heavy compounds, 3–5 reps) and two **hypertrophy** days (8–12, more isolation):
    Upper Power, Lower Power, Upper Hypertrophy, Lower Hypertrophy. Swap/log/share/save like the
    other fixed templates.
  - **Hyrox prep (fixed template):** a weekly block tuned to the Hyrox race (8×1 km run, each into
    a station — SkiErg, Sled Push/Pull, Burpee Broad Jumps, Row, Farmers Carry, Sandbag Lunges, Wall
    Balls). Six pickable days: **Lower Strength + Sled, Compromised Running, Ergs + Strength
    Endurance, Pull Strength + Grip, Simulation (mixed), and Zone 2 Aerobic Base.** Loaded stations
    (sled, wall ball, carry, sandbag, barbell) track his/hers weight; the runs and ergs log as
    time/distance. Swap/log/share/save like the other fixed templates. Run ~5–6 days a week, picking
    the right day each session.
  - **nSuns 531 LP (percentage-based):** the popular 6-day "deadlift focus" linear progression.
    Unlike everything else, this one is driven by **your 1-rep maxes**, not RPE. Enter a true 1RM
    for the four main lifts (Squat, Bench, Deadlift, Press) for **each person**; the app sets your
    **training max** to 90% of it and computes the **exact weight for every set** as a percentage of
    that TM, snapped to a loadable barbell — the way the spreadsheet does. Each day is a main lift
    (the 9-set 5/3/1+ ladder, with an **AMRAP "+" set**) plus a secondary lift run off the related
    lift's TM, plus an assistance note. **Edit a 1RM and the whole workout re-scales instantly** —
    so when you hit all your reps on the + set, bump that lift's 1RM to progress. (The four 1RMs you
    enter here also feed the dynamic program's percentage suggestions.)
  - **Madcow 5×5 (percentage-based):** the classic StrongLifts successor — 3 days (Volume / Light /
    Intensity) where each lift **ramps up to a top set**, and you progress **weekly**. Uses the same
    1RMs as nSuns/5-3-1 (plus a Barbell Row 1RM, which only appears when you pick Madcow). Friday
    chases a new top **triple** with a back-off set of 8; add ~2.5% to each lift's 1RM weekly and
    the ramps re-scale.
  - **Texas Method (percentage-based):** 3-day intermediate — a big **Volume** day (5×5 across), a
    **Light** recovery day, and an **Intensity** day where you ramp to a new top set of 5. Weekly
    progression: beat Friday, raise that lift's 1RM.
  - **GZCLP (fixed template):** the GZCL-method beginner LP built on **tiers** — **T1** (main, heavy
    5×3+, progressing 5×3 → 6×2 → 10×1 on a stall), **T2** (secondary volume, 3×10 → 3×8 → 3×6), and
    **T3** (accessory, 3×15+). Four sessions rotate A1/A2/B1/B2. Like the other LP templates the
    weight is tracked by logging (add each session). Swap/log/share/save supported.
  - **5/3/1 classic (percentage-based):** Jim Wendler's original — lower volume, slower-but-forever.
    One main lift per day (Press, Deadlift, Bench, Squat), driven by the **same four 1RMs** as nSuns
    (TM = 90%). It runs the **3-week wave** — *Week 1 = 5s (65/75/85+), Week 2 = 3s (70/80/90+),
    Week 3 = 5/3/1 (75/85/95+)*, each ending in an **AMRAP "+" set** — plus a **Week 4 deload**;
    switch weeks with the toggle at the top. Includes Wendler's warm-up sets and **Boring But Big**
    supplemental work (5×10 @ 50% TM), plus a per-day **assistance block** — a push / pull /
    single-leg-or-core accessory seeded with a sensible default you can **swap, "don't suggest", add
    to, or edit/log the weight on**, just like the freestyle generator (Wendler's 50–100 reps of
    each). Finish a cycle and bump that lift's 1RM (+5 upper / +10 lower) to start the next. (See the in-app difference vs. nSuns: nSuns piles on ~17 sets/day and
    progresses weekly; 5/3/1 is 3 work sets and progresses per cycle.)
  - **Freestyle (CrossFit-style):** the original generator — Warm Up → Strength 1 → Strength 2
    superset → MetCon. Leave it on *Auto* to pick the freshest focus, or choose a specific one.
- **Warm-ups match the day:** the warm-up only pulls mobility/prep for the regions you're about to
  train (plus generally-useful full-body moves) — no hip openers before a bench day.
- Each loadable move shows **You / Her** weights, snapped to what you can actually load (DB
  ladder, plate pairs, KB kg steps). **Tap a weight (✎) to edit** — it's saved as your working
  weight for next time.
- **Swap** any move for a same-body-region alternative (kept near the same zone). **Don't
  suggest** bans it from future sessions (undo under **Avoided moves**).
- **Log this session** opens a per-person form. It's built to stay fast but capture detail when
  you want it:
  - **Blank = done as prescribed.** Leave everything alone and tap Save to fast-log — the
    suggested weights are recorded and progression stays conservative (it *holds*, since it's an
    assumed result, not a measured one). If you fill in *some* fields and leave others blank, it
    confirms before logging the blanks as suggested.
  - **Done / Partial / Skipped** per person (default Done). Partial backs the weight/hold off next
    time; Skipped changes nothing; Done with a measured **RPE** progresses normally (≤7 up, 8–9
    hold, ≥10 or missed down).
  - **Same weight for all sets?** is on by default (one weight box). Uncheck it for **per-set
    rows** — log a top set + backoff (e.g. 135 / 115 / 115) or a drop set. It remembers your *top*
    set but suggests the **repeatable** weight (here ~115) next time.
  - **Timed holds** (planks, etc.) log *target vs. actual seconds*. Hold 45s of a 60s target and
    next time it suggests ~45s instead of blindly repeating 60.
  Logging also feeds the recovery model so tomorrow's session knows what's still fatigued.
- **Progress** (button in the footer) is a per-person dashboard: toggle **You / Her** and see each
  movement's program slot, **last** set (top + repeatable weight, or hold seconds, with Partial/
  assumed tags), **best** ever logged, **estimated 1RM**, and how many sessions you've logged it.
- **Add / remove / undo:** **+ Accessory** and **+ Finisher** append an extra, day-appropriate
  move (respecting region, avoid-list, programDefault, and busy-day crowd rules). **✕ Remove** asks
  to confirm, and an **↶ Undo** button reverses your last add/remove. A **workload meter** shows
  total working sets and turns amber/red if you're piling on too much volume.
- **Saved automatically + named saves:** the workout you're looking at is **auto-saved on the
  device**, so it's still there when you reopen the app (generate in the morning, it's waiting at
  the gym). **Save** stores a **named** copy you can reopen anytime from the **Saved** screen
  (footer) — handy for a go-to session. Logging a session clears the auto-saved one so you next see
  your upcoming day.
- **Share a workout (serverless):** the **Share** button packs the *plan* (exercises, sets/reps —
  not weights) into a **link** and a **code**. Use the native **Share…** sheet (AirDrop / Messages)
  or copy the link/code; open it on the other device — your wife's phone, or your own phone at the
  gym after generating on your laptop — and tap **Load shared** (or just open the link) to load the
  exact same workout. Each person then enters their **own** weights and can keep editing their own
  copy. No account or server; the plan rides inside the link itself.
- **Slot continuity:** within the program, each day's main/secondary/accessory **slot remembers
  the movement you actually did** and reuses it next time, so your load history accumulates on
  one lift instead of scattering. Swap any time — the swapped movement becomes the new slot pick.
- **Export backup** saves your data to a JSON file; **Import** loads it. Data lives on the
  device, so drive each session from one phone and use export/import to sync the other.
- **Version check:** the app version shows at the bottom of the screen; it flips to
  **"update ready — tap to refresh"** when a newer deploy is available, so you can tell whether
  each phone is on the latest.

## Configuring your gym

Everything gym-specific is in `app/gym.json`:
- **zones** — your floor layout (A–E) and which zones are adjacent, so supersets stay close.
- **inventory** — the dumbbell / plate / kettlebell / barbell ladders the load rounder uses.
- **crowd** — `busyDays` (e.g. Mon/Tue/Wed) and `crowdedZones` (the bench/DB end **A** and the
  machines **C**). On a busy weekday the generator reads today's date and steers away from
  movements that can *only* be done in a crowded zone, toward the rigs (**B**), open floor (**E**),
  and cardio (**D**) — e.g. a bench day becomes a barbell overhead press or pull-ups on the rig,
  or dumbbell work in the open area, instead of waiting for a bench or machine. A movement that has
  an alternative zone isn't penalized (you just do it in the open spot), and if every option is
  crowded it still picks one. The session card shows a 🚦 note on busy days.

Movement tags (pattern, equipment, which zone, day/space limits) live in `app/movements.json`.
For example, a space-heavy move can be capped to certain days and a max frequency via
`preferredDays` and `frequencyCapPerWeeks`.

**Program vs. Freestyle movement pools.** The prescriptive **Program** mode draws only from
conventional, repeatable gym movements. CrossFit/Olympic/specialty/skill moves (cleans, snatches,
thrusters, devil press, push-press/jerk variants, floor press, muscle-ups, box jumps, etc.) are
tagged `"programDefault": false`, which keeps them out of generated program sessions and program
swaps — but they're still available in **Freestyle** mode and as manual swaps there. To pull a
movement back into the program, delete its `programDefault` flag (or set it to `true`).

**Movement tiers.** Within the Program pool, movements tagged `"tier": "core"` (the boring,
repeatable, easy-to-progress staples — bench, squat, RDL, pulldown, hack squat, cable lateral
raise, etc.) get a selection boost so they show up more than `secondary`/untagged variations.
Specialty/CrossFit moves are already excluded via `programDefault`, so the in-program choice is
really "core vs. everything else." A few moves are scheduled deliberately rare with
`frequencyCapPerWeeks` (e.g. Sumo Deadlift).
