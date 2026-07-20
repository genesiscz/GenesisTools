# magick-golden fixtures

Reference outputs of the PRE-MIGRATION ImageMagick compositing paths in
`capture-with-actions.ts`, generated 2026-07-20 with ImageMagick 7.1.2-13
before the @napi-rs/canvas migration. Task-6 pixelmatch baselines.

- `frames/keep-000{1..4}.png` — real peekaboo capture frames (960x540, TextEdit
  showcase recording), timestamps assigned 0/400/800/1200 ms.
- `plan.json` — the recrop plan: sequential crop `toolbar` (720x300, all 4
  frames) + explicit-window crop `text` (500x200, toMs 900 → frames 1-3).
- `crops/` — the 7 labeled tiles + `strip.png` (720x2066; mixed widths exercise
  magick's -append white padding) + `strip-review.png` (558x1600 downscale).
- `clickmap-raw.png` + `clickmap.png` + `clickmap-meta.json` — a real
  `clickmap --app Finder` run; meta carries the frozen window bounds/grid so the
  canvas reimplementation can be replayed on the same input.

Baseline per-op timings (hyperfine, warmup 2, 10 runs, Apple Silicon):
crop+label 164.0ms ±3.2 · strip append (7 tiles) 109.3ms ±1.2 ·
strip-review resize 86.4ms ±0.6 · clickmap grid+labels 969.7ms ±34.2.

Text areas (label bars, grid labels) rasterize differently in Skia vs magick BY
DESIGN — pixelmatch with AA tolerance applies to geometry; text zones get one
human visual review (see the migration PR).
