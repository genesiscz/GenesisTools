#!/usr/bin/env bun
/**
 * Phase-2 boundary moves for the flat @genesiscz/utils design
 * (.claude/plans/2026-07-18-FlatGenesisczPackages.md, steps 4+6).
 *
 * - telegram: notifications channel dynamic-imports telegram-bot's api/
 *   formatting (the guard missed them — `await import()`, not static).
 *   Closure is tiny (grammy + ./types), so the three files move into utils.
 * - youtube-ui: utils/ui/components/youtube/* is youtube feature UI
 *   mis-located in shared utils — moves OUT to src/youtube/ui/components/
 *   shared/ (both the web ui and the extension resolve it via the @app
 *   vite alias).
 * - log-viewer: user decision — it is tool-adjacent (needs task +
 *   debugging-master internals), so it moves OUT of utils to
 *   src/log-viewer/. Its imports of the two tools become tool->tool
 *   backlog warnings instead of utils impurities.
 * - logger: folds INTO utils (the logger <-> cli/prompts cycle becomes
 *   intra-package). NOTE: needs manual follow-ups in the same commit —
 *   root `tools` (extensionless, rg misses it), scripts/ci/logging-guard.sh
 *   regexes, src/utils/logger/client-isolation.test.ts patterns, the
 *   boundary guard's src/logger path checks, CLAUDE.md examples.
 *
 * Usage: bun scripts/codemods/2026-07-18-phase2-moves.ts --only <id> [--dry]
 */
import { applyMove, type Move } from "./lib/codemod";

const MOVES: Move[] = [
    {
        id: "telegram",
        description: "telegram-bot lib/{api,formatting,types} (dynamic-imported by utils/notifications/channels/telegram)",
        gitMoves: [
            { from: "src/telegram-bot/lib/api.ts", to: "src/utils/telegram-bot/lib/api.ts" },
            { from: "src/telegram-bot/lib/formatting.ts", to: "src/utils/telegram-bot/lib/formatting.ts" },
            { from: "src/telegram-bot/lib/types.ts", to: "src/utils/telegram-bot/lib/types.ts" },
        ],
        specRewrites: [
            { from: "@app/telegram-bot/lib/api", to: "@app/utils/telegram-bot/lib/api" },
            { from: "@app/telegram-bot/lib/formatting", to: "@app/utils/telegram-bot/lib/formatting" },
            { from: "@app/telegram-bot/lib/types", to: "@app/utils/telegram-bot/lib/types" },
        ],
        fileRewrites: [
            { file: "src/telegram-bot/lib/config.ts", from: "./types", to: "@app/utils/telegram-bot/lib/types" },
        ],
    },
    {
        id: "youtube-ui",
        description: "youtube feature components OUT of shared utils/ui into src/youtube/ui/components/shared",
        gitMoves: [{ from: "src/utils/ui/components/youtube", to: "src/youtube/ui/components/shared" }],
        specRewrites: [
            { from: "@app/utils/ui/components/youtube", to: "@app/youtube/ui/components/shared" },
        ],
    },
    {
        id: "log-viewer",
        description: "log-viewer OUT of utils to src/log-viewer (tool-adjacent: needs task + debugging-master internals)",
        gitMoves: [{ from: "src/utils/log-viewer", to: "src/log-viewer" }],
        specRewrites: [{ from: "@app/utils/log-viewer", to: "@app/log-viewer" }],
    },
    {
        id: "logger",
        description: "logger folds INTO utils (cycle with cli/prompts becomes intra-package)",
        gitMoves: [
            { from: "src/logger.ts", to: "src/utils/logger.ts" },
            { from: "src/logger.test.ts", to: "src/utils/logger.test.ts" },
            { from: "src/logger", to: "src/utils/logger" },
        ],
        specRewrites: [{ from: "@app/logger", to: "@app/utils/logger" }],
    },
];

const args = Bun.argv.slice(2);
const dry = args.includes("--dry");

if (args.includes("--list")) {
    for (const m of MOVES) {
        console.log(`${m.id}: ${m.description}`);
    }

    process.exit(0);
}

const onlyIdx = args.indexOf("--only");
let selected = MOVES;
if (onlyIdx !== -1) {
    const id = args[onlyIdx + 1];
    selected = MOVES.filter((m) => m.id === id);
    if (selected.length === 0) {
        console.error(`unknown move id: ${id}`);
        process.exit(1);
    }
} else if (!args.includes("--all")) {
    console.error("pass --only <id>, --all, or --list");
    process.exit(1);
}

for (const move of selected) {
    await applyMove(move, dry);
}

console.log("\ndone. verify: tsgo --noEmit && bun scripts/ci/check-package-boundaries.ts");
