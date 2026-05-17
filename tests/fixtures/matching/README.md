# Golden-pair fixture set

10 product fixtures driving the matcher's F1 ≥ 0.95 build gate.

Each entry has:
- `description` — human-readable label.
- `expected_master_group` — products that MUST collapse into one master.
- `expected_separate_groups` — array of arrays for products that MUST stay separate (e.g. flavor variants of Lindor each form their own group).

## URL refresh

URLs are durable identities, not live shop links. The harness in `src/shops/lib/golden-harness.ts` does NOT fetch — it constructs synthetic master/product rows directly from these fixtures. URLs are kept for human reference (so you can verify product identity in a browser).

## What the F1 gate covers

- Layer 0 (EAN) — entries 01, 02, 06, 08
- Layer 1 (full signature + fuzzy name) — most masters with size + flavor
- Layer 2a/2b (signature missing flavor or size) — entry 10
- Layer 3 (brand only) — entries 04, 05
- Multi-pack guard — entry 07
- Private label discrimination — entry 09 (must NOT cross-merge)
- Flavor variant separation — entry 03

## Tuning workflow

1. Run `bun test tests/matching/golden-pairs.test.ts`.
2. If F1 < 0.95, the test prints per-pair diagnostics (FP/FN labels, layer that fired, score).
3. Adjust `src/shops/lib/matcher-config.ts` thresholds.
4. Re-run.
