#!/usr/bin/env bun
/**
 * The @genesiscz/utils cutover (plan: .claude/plans/2026-07-18-FlatGenesisczPackages.md).
 *
 * Move 1 `history-cache`: relocates the pure claude history cache into utils so
 * src/utils/agent-runtime.ts loses its last @app/<tool> import.
 * Move 2 `genesiscz-cutover`: rewrites every `"@app/utils…` import specifier to
 * `"@genesiscz/utils…` across all tracked *.ts/*.tsx (scripts/codemods excluded
 * as frozen history). Infra files that mention the alias outside import
 * specifiers (biome.json, vite configs, standalone tsconfigs, logging-guard.sh,
 * client-isolation.test.ts expectations) are updated manually in the same
 * commit — they are configs, not import sites, and each needs judgment.
 *
 * Usage: bun scripts/codemods/2026-07-18-genesiscz-cutover.ts [moveId…] [--dry]
 */
import { applyMove, type Move } from "./lib/codemod";

const MOVES: Move[] = [
    {
        id: "history-cache",
        description: "claude/lib/history/cache.ts -> utils/claude/history-cache.ts (agent-runtime purity)",
        gitMoves: [{ from: "src/claude/lib/history/cache.ts", to: "src/utils/claude/history-cache.ts" }],
        specRewrites: [{ from: "@app/claude/lib/history/cache", to: "@app/utils/claude/history-cache" }],
        fileRewrites: [
            { file: "src/claude/lib/history/index.ts", from: "./cache", to: "@app/utils/claude/history-cache" },
            { file: "src/claude/lib/history/search.ts", from: "./cache", to: "@app/utils/claude/history-cache" },
        ],
    },
    {
        id: "genesiscz-cutover",
        description: "@app/utils -> @genesiscz/utils repo-wide (ts/tsx import specifiers)",
        gitMoves: [],
        specRewrites: [{ from: "@app/utils", to: "@genesiscz/utils" }],
    },
    {
        id: "ask-providers",
        description:
            "ask provider config table -> utils (pure: only ProviderConfig type) — kills the @ask dynamic-import leak in utils/ai/resolvers",
        gitMoves: [{ from: "src/ask/providers/providers.ts", to: "src/utils/ask/providers/providers.ts" }],
        specRewrites: [{ from: "@ask/providers/providers", to: "@genesiscz/utils/ask/providers/providers" }],
        fileRewrites: [
            { file: "src/utils/ask/providers/providers.ts", from: "@ask/types", to: "@genesiscz/utils/ask/types" },
        ],
    },
];

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const ids = args.filter((a) => a !== "--dry");
const selected = ids.length > 0 ? MOVES.filter((m) => ids.includes(m.id)) : MOVES;

if (selected.length === 0) {
    console.error(`No moves matched ${ids.join(", ")}. Available: ${MOVES.map((m) => m.id).join(", ")}`);
    process.exit(1);
}

for (const move of selected) {
    await applyMove(move, dry);
}
