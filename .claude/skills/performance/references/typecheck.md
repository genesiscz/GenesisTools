# Type-check cost: memory and time of a TypeScript program

A TypeScript program's memory follows its size first and its code shapes second. Measured on the GenesisTools root
program on 2026-10-25 (TypeScript 6.0, 9,995 files, 101.6 MB of source): retained heap after a full GC was parse
1,943 MiB, bind 2,451 MiB, check 4,389 MiB. Parse plus bind costs about 24 MiB of heap per MB of source, `.d.ts`
included. A reviewer that runs `ts.createProgram` with a 3 GiB heap failed on it.

## The instrument: `tools ts program`

It checks in a separate `node` process (V8, the heap `tsc` and reviewers use) with the project's own `typescript`.

- `tools ts program cost [tsconfig]`: heap after each phase, counts (types, instantiations, symbols), diagnostics.
  `--heap 3072` passes or fails as out of memory, like a 3 GiB reviewer.
- `tools ts program files --top 30` (`--by instantiations|types|symbols|ms`, `--folders`): what each file's check
  created. The first file that touches a library type pays for it: read a ranking, not ownership.
- `tools ts program own <file>`: one file's own work (everything else checked first). THE before and after
  instrument for an edit.
- `tools ts program closure` (`--why <package>`): what a tsconfig of one folder would hold; declaration packages by
  size with their direct importers; packages present from more than one installed copy (from an audit of a large
  private app on 2026-07-10, where duplicate copies were typechecked 2 to 6 times).
- `tools ts program trace` (`--min-ms`): `tsc --generateTrace`, then the slowest files and single expressions with
  their source line.
- `tools ts program sites` (`--by median --min-sites 3`, `--project-only`, `--key <text>`): THE "next worse" finder,
  no agents and no reading. Each call, `new`, JSX element and type reference is resolved on its own during the first
  check and grouped by what it calls (`name @ declaring file`). A high median over many sites is a shape that costs
  at every use; one big site with a low median is first use of a library type. Positive control (2026-10-25): on the
  commit before the fixes below it ranked the ElementType icons 2nd and 6th to 11th, `new Chart` 12th,
  `generateText` 15th and `Parameters<typeof …>` 34th, with nothing pointed at them.

## The loop

1. `cost` for the baseline, `sites` (then `--by median --min-sites 3`) and `trace --min-ms 50` for candidates.
2. For each candidate: `own <file>`, change the TYPE only, `own <file>` again. Keep the change only when the numbers
   drop and diagnostics stay 0.
3. Prove the JavaScript did not change: transpile old and new with `new Bun.Transpiler({ loader: "tsx" })`, strip
   comments, compare. A planted change must read DIFFERENT (positive control).
4. `cost` again for the program-wide number, and an interleaved A/B (a HEAD worktree against the change, 3 rounds,
   medians) for time. A single file's `own` number overstates program savings when the cost was shared first-touch
   work: on 2026-10-25 a per-file sum claimed 43k fewer instantiations and the program showed 10.8k.

## Shapes that cost a lot, with numbers

- **Inference over a big union parameter.** `new Chart(canvas, config)` (chart.js) inferred three type parameters
  over a union of every chart type: 1,084 ms and 250k symbols for ONE expression. `new Chart<ChartType>(…)`: 12 ms.
  A typed variable and an `Object.assign` instead of the spread did not help; the explicit type argument did.
- **A prop type that is secretly a union of every HTML tag.** `React.ElementType<P>` (icons, `LinkComponent`) made
  each JSX use check its props against every intrinsic element: about 175k instantiations and 220 to 250 ms per file.
  `React.ComponentType<P>`: 4 to 38 ms. ElementType stays right only for a polymorphic `as` prop.
- **Spreading a wide type into an object literal.** `{ ...bandLayer }` with `bandLayer: CSSProperties` copies every
  CSS property into a new type: types 4,996 → 2,403 with `Pick<CSSProperties, "backgroundImage">`.
- **A type derived from a library function's parameters.** `Parameters<typeof generateText>[0]["model"]` instantiates
  the whole generic signature; the library exports the same type as `LanguageModel`.
- **A generic inferred from a zod schema parameter.** `fn<T>(schema: z.ZodType<T>)` makes the checker infer `T` by
  walking the whole schema type against ZodType at every call: about 3,400 instantiations per `callLLMStructured`
  call and 81k for the first `parseDecisionInput` of a large schema. Make the schema the type parameter:
  `fn<S extends z.ZodType>(schema: S): z.output<S>`. Both together: program instantiations 2,380,257 → 2,333,331
  (−2.0%), 0 diagnostics, identical JavaScript (2026-10-25). Found by `sites --by median --min-sites 3`.
- **A library's typed routes or query builder, paid once per program.** Any typed `octokit.request("GET …")` costs
  about 44k types and 160k instantiations whatever the call shape; kysely chains were 17 to 21% of all instantiations
  with no type-only fix found. Measure, then leave them unless the program can drop the library.
- **A large `.d.ts` package used by one file.** Stripe: 228 files, 5.9 MB, one importer; moved to the package store
  (installed on first use) with a local type for the one call: −228 files from every program.
- **Test files.** 1,983 bun:test files held 35% of all symbols and 27% of check time (2026-10-25). Not a code fix; a
  reason a smaller program (one folder, or only a change's files) is the real lever.

## Correctness traps of a smaller program

A program of one folder, or of only a change's files, needs 0.3 to 1.5 GB instead of 4 GiB, and it misses what the big
program got by accident:

- **TypeScript 6 adds no `@types` package to the global scope unless `types` names it.** An import of a package still
  loads that package's types; only the automatic global inclusion stopped. Bun's globals came only from the one file
  that imports `bun`, so a smaller program said "Cannot find name 'Bun'" (141 errors in one sample). Name it:
  `"types": ["bun"]`.
- **Ambient `.d.ts` files that nothing imports** (`declare module "asciichart"`, a `marked` augmentation) exist only in
  a program whose include matches them. Include `src/**/*.d.ts` (or the folder's `../**/*.d.ts`).
- **`declare global` inside a module file** is seen only when that file is in the program.
