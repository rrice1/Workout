# Workout Generator

A phone-friendly **PWA** that generates CrossFit/Hyrox-style sessions and rotates movement
patterns so you don't overwork anything from earlier in the week. It tracks your loads,
suggests his/hers weights you can actually load with your gym's equipment, and keeps supersets
in the same area of the gym so you're not crossing the floor mid-set.

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

Then open <http://localhost:8000> and click **Generate today**.

Run the logic self-check with `node app/test.js`.

## Put it on your phones (the real use)

iOS needs **https** for offline mode, so host the `app/` folder with GitHub Pages:

1. In the repo, turn on **Settings → Pages** (deploy from branch). GitHub gives you an
   `https://<you>.github.io/...` URL.
2. Open that URL in **Safari** on each phone → Share → **Add to Home Screen**.
3. It now has its own icon, runs full-screen, and works **offline**.

No App Store, no build, no signing, no expiry. To update later, edit the files and push — bump
`CACHE` in `service-worker.js` to force the offline cache to refresh.

## Using it

- **Follow the program (recommended):** the top card shows your next scheduled session —
  e.g. *Week 2/4 · Day 3 of 6 — Pull Strength* — and **Generate Next Workout** builds it. The
  sequence advances **only when you log a program session** (skipping a calendar day doesn't
  skip a workout; freestyle sessions don't advance it). It runs a **4-week wave**: weeks 1–3
  ramp up, week 4 is an automatic **deload** (lighter loads, fewer sets). Toggle **6 vs 7
  training days** (the 7th is an easy Pump / Recovery day, never required).
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
- The **This week so far** card shows **hard sets per muscle vs target** and cardio exposures,
  so you can see what's under- or over-trained across the week.
- Or **pick manually** from the dropdown — two families:
  - **Program (prescriptive split):** Push Strength, Lower Strength — Squat, Pull Strength,
    Conditioning + Core, Upper Hypertrophy, Lower Hypertrophy — Hinge, Pump / Recovery. Each day
    has a clear identity, its own block structure, forbidden patterns (e.g. no legs on push day),
    and an intensity cap — built for training 6–7 days/week without frying yourself.
  - **Freestyle (CrossFit-style):** the original generator — Warm Up → Strength 1 → Strength 2
    superset → MetCon. Leave it on *Auto* to pick the freshest focus, or choose a specific one.
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
- **Slot continuity:** within the program, each day's main/secondary/accessory **slot remembers
  the movement you actually did** and reuses it next time, so your load history accumulates on
  one lift instead of scattering. Swap any time — the swapped movement becomes the new slot pick.
- **Export backup** saves your data to a JSON file; **Import** loads it. Data lives on the
  device, so drive each session from one phone and use export/import to sync the other.

## Configuring your gym

Everything gym-specific is in `app/gym.json`:
- **zones** — your floor layout (A–E) and which zones are adjacent, so supersets stay close.
- **inventory** — the dumbbell / plate / kettlebell / barbell ladders the load rounder uses.

Movement tags (pattern, equipment, which zone, day/space limits) live in `app/movements.json`.
For example, a space-heavy move can be capped to certain days and a max frequency via
`preferredDays` and `frequencyCapPerWeeks`.

**Program vs. Freestyle movement pools.** The prescriptive **Program** mode draws only from
conventional, repeatable gym movements. CrossFit/Olympic/specialty/skill moves (cleans, snatches,
thrusters, devil press, push-press/jerk variants, floor press, muscle-ups, box jumps, etc.) are
tagged `"programDefault": false`, which keeps them out of generated program sessions and program
swaps — but they're still available in **Freestyle** mode and as manual swaps there. To pull a
movement back into the program, delete its `programDefault` flag (or set it to `true`).
