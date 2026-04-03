# Compare + Listings Bugfixes

## Scope
- Add explicit compare-period defaults/selection so `/compare` sends meaningful sold horizons.
- Improve persisted listing district derivation from listing locality/address instead of stamping requested district.
- Add low-risk district validation for Bezrealitky and eReality in the same spirit as existing Sreality filtering.
- Tighten Prague ward REAS sold filtering to reduce obviously city-wide garbage.
- Add a safe repair path for stale cached listing districts and run it locally if feasible.

## Plan
1. Inspect current compare query, district-comparison API, persistence, and provider filtering code.
2. Add failing regression tests for compare periods, district derivation/filtering, and Prague ward filtering.
3. Implement focused utility/helpers for district parsing/matching and reuse them in persistence + provider clients.
4. Add a repair/backfill method for cached listing districts and wire a safe invocation path.
5. Run targeted tests, type/lint checks, and local verification for `/compare` and `/listings` when possible.
