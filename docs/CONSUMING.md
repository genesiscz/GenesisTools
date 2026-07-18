# Consuming GenesisTools from other repos

Two packages, no build step, Bun-first. Both ship raw `.ts` sources; TypeScript
resolves them through a shipped `tsconfig.consumer.json` fragment, and Bun
resolves the packages' internal aliases at runtime from each package's own
`tsconfig.json` (Bun reads a dependency's nearest tsconfig inside
`node_modules` — validated empirically on Bun 1.3.x).

| Package | What | Where | Distribution |
|---|---|---|---|
| `@genesiscz/utils` | everything general-purpose (json, logger, cli, prompts, ai, macos, …) | `src/utils/` | npm (publish pending) or workspace |
| `@genesiscz/tools` | the whole repo — every `src/<tool>/` (ask, cmux, task, youtube, …) | repo root | git dependency (zero release lag) |

## `@genesiscz/tools` via git dependency

```jsonc
// consumer package.json
{
    "dependencies": {
        "@genesiscz/tools": "git+ssh://git@github.com/genesiscz/GenesisTools.git#master"
    }
}
```

```jsonc
// consumer tsconfig.json
{
    "extends": "./node_modules/@genesiscz/tools/tsconfig.consumer.json"
}
```

The fragment maps `@genesiscz/utils`, `@genesiscz/utils/*`, and
`@genesiscz/tools/*` (→ `src/*`) onto the package's sources; paths resolve
relative to the fragment's own location, so the extends is all you need.

```ts
import { SafeJSON } from "@genesiscz/utils/json";
import { callLLM } from "@genesiscz/utils/ai/call-llm";
import { something } from "@genesiscz/tools/ask/lib/whatever";
```

Notes:

- Bun cannot install a subdirectory of a git repo — a git dep always brings
  the whole tree. That's the point here: the tools package IS the repo.
- Internal `@app/<tool>` imports inside the dep resolve through the dep's own
  root `tsconfig.json` at runtime (Bun), and through the fragment for your
  typechecker only where you import them.
- No dependency lifecycle scripts run for git deps unless the consumer adds
  the package to `trustedDependencies` — nothing in this repo requires it.

## `@genesiscz/utils` standalone

Inside this repo it's a Bun workspace member (`workspaces: ["src/utils"]`).
Externally, once published to npm:

```bash
bun add @genesiscz/utils
```

```jsonc
// consumer tsconfig.json
{ "extends": "./node_modules/@genesiscz/utils/tsconfig.consumer.json" }
```

- The curated `exports` map in `src/utils/package.json` covers every
  top-level module and dir barrel (`./json`, `./logger`, `./logger/client`,
  `./cli`, `./ai`, …) — those subpaths work even WITHOUT the fragment.
  Deep un-exported paths (`@genesiscz/utils/macos/MailDatabase`-style) need
  the fragment.
- `react`, `react-dom`, `ink` are optional peer dependencies — only needed
  if you import the UI/TUI parts.
- `@ai-sdk/assemblyai` / `@ai-sdk/gladia` are optional peers, lazy-imported by
  the transcription manager; install them only if you use those providers.
- Model resolution (`ai/resolvers`) enriches models with pricing via the ask
  tool's DynamicPricing when running inside `@genesiscz/tools`; in a
  standalone `@genesiscz/utils` install it degrades gracefully to
  pricing-less models (the one documented cross-boundary escape hatch — see
  `PURITY_EXEMPTIONS` in `scripts/ci/check-package-boundaries.ts`).

### Publishing (manual, deliberate)

`src/utils/package.json` keeps `"private": true` until the moment of publish
(`publishConfig.access` is already `public`):

```bash
cd src/utils
# flip "private": false, then:
bun publish
```

## Boundary contract

`scripts/ci/check-package-boundaries.ts` enforces:

1. FAIL — nothing under `src/utils/**` imports `@app/*` or `@ask/*` (tool
   internals). The utils package stays consumable standalone.
2. FAIL — no `@app/utils…` specifier anywhere: the legacy alias is dead;
   use `@genesiscz/utils…` (re-run
   `scripts/codemods/2026-07-18-genesiscz-cutover.ts` after bulk edits).
3. WARN — tool → other tool imports (`@app/<other>/…`), the known backlog.
