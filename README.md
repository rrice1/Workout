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

- Pick a **Workout type**, then **Generate**. Two families:
  - **Program (prescriptive split):** Push Strength, Lower Strength — Squat, Pull Strength,
    Conditioning + Core, Upper Hypertrophy, Lower Hypertrophy — Hinge, Pump / Recovery. Each day
    has a clear identity, its own block structure, forbidden patterns (e.g. no legs on push day),
    and an intensity cap — built for training 6–7 days/week without frying yourself.
  - **Freestyle (CrossFit-style):** the original generator — Warm Up → Strength 1 → Strength 2
    superset → MetCon. Leave it on *Auto* to pick the freshest focus, or choose a specific one.
- Each loadable move shows **You / Her** suggested weights, computed from your tracked
  1-rep-max estimates and snapped to weights you can actually load (DB ladder, plate pairs,
  KB kg steps). Tap to edit anytime.
- **Swap** any move for a same-body-region alternative (kept near the same zone). **Don't
  suggest** bans it from future sessions (undo under **Avoided moves**).
- **Log this session** records it so tomorrow's generation knows what's still recovering.
- **Export backup** saves your data to a JSON file; **Import** loads it. Data lives on the
  device, so drive each session from one phone and use export/import to sync the other.

## Configuring your gym

Everything gym-specific is in `app/gym.json`:
- **zones** — your floor layout (A–E) and which zones are adjacent, so supersets stay close.
- **inventory** — the dumbbell / plate / kettlebell / barbell ladders the load rounder uses.

Movement tags (pattern, equipment, which zone, day/space limits) live in `app/movements.json`.
For example, a space-heavy move can be capped to certain days and a max frequency via
`preferredDays` and `frequencyCapPerWeeks`.
