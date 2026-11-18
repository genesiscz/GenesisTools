---
status: Proposed
date: 2026-11-18
---

# Choose whether to split the Meetings service contract

R1, P2 and P6 add methods to the same contract in successive waves. Option A, recommended in the plan, keeps
`service/api.ts` together and accepts that scheduling constraint. Option B runs P6A after P6 in wave 5. Family
files would own method schemas, with shared schemas in `api/shared.ts`. The public imports, method order,
protocol fingerprint and fixture must stay identical. Only P6A waits for this choice.

`.claude/plans/2026-11-18-MeetingsArchitecture.md`, "`service/api/<family>.ts` (P6A, only on D2 b)", "P6A: A6. The service contract splits by method family", "Decisions".
