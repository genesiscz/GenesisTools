#!/usr/bin/env bun
/**
 * Boundary-violation moves for the flat @genesiscz/utils design
 * (.claude/plans/2026-07-18-FlatGenesisczPackages.md, step 3).
 *
 * Principle (user-set): move ONLY the files src/utils actually imports —
 * never a whole tool dir. Moved files mirror their tool path under
 * src/utils/ (src/ask/types/chat.ts -> src/utils/ask/types/chat.ts).
 * Files that stay behind get their imports of moved siblings rewritten to
 * the new @app/utils/* location; tool-side barrels keep re-exporting so
 * unrelated importers stay untouched.
 *
 * Specifier targets stay on the @app/utils/* alias for now — the big
 * @app/utils -> @genesiscz/utils cutover is a later, separate codemod.
 *
 * APPLIED 2026-07-18 (all moves). Kept re-runnable: applying to an
 * already-migrated tree is a no-op (git mv fails loudly, rewrites find
 * nothing). The lib excludes scripts/codemods/** from rewrites so this
 * table's own `from` strings survive a run.
 *
 * Usage:
 *   bun scripts/codemods/2026-07-18-boundary-moves.ts --list
 *   bun scripts/codemods/2026-07-18-boundary-moves.ts --only jwt [--dry]
 *   bun scripts/codemods/2026-07-18-boundary-moves.ts --all [--dry]
 */
import { applyMove, type Move } from "./lib/codemod";

const MOVES: Move[] = [
    {
        id: "jwt",
        description: "jwt-core (imported by utils/ai/grok/auth) out of the jwt tool",
        gitMoves: [{ from: "src/jwt/lib/jwt-core.ts", to: "src/utils/jwt.ts" }],
        specRewrites: [{ from: "@app/jwt/lib/jwt-core", to: "@app/utils/jwt" }],
        fileRewrites: [
            { file: "src/jwt/index.ts", from: "./lib/jwt-core", to: "@app/utils/jwt" },
            { file: "src/jwt/jwt.test.ts", from: "./lib/jwt-core", to: "@app/utils/jwt" },
        ],
    },
    {
        id: "ask-types",
        description: "ask/types/{chat,provider} (the two files utils imports; cli/config/pricing stay)",
        gitMoves: [
            { from: "src/ask/types/chat.ts", to: "src/utils/ask/types/chat.ts" },
            { from: "src/ask/types/provider.ts", to: "src/utils/ask/types/provider.ts" },
        ],
        createFiles: [
            {
                path: "src/utils/ask/types/index.ts",
                content: 'export * from "./chat";\nexport * from "./provider";\n',
            },
        ],
        specRewrites: [
            // Direct subpath imports of the moved files — safe repo-wide.
            { from: "@ask/types/chat", to: "@app/utils/ask/types/chat" },
            { from: "@ask/types/provider", to: "@app/utils/ask/types/provider" },
            // Barrel imports: only utils files switch to the new (chat+provider-only)
            // barrel; everything else keeps the ask-side barrel, which still
            // re-exports cli/config/pricing locally + the moved files from utils.
            { from: "@ask/types", to: "@app/utils/ask/types", scope: "src/utils" },
        ],
        fileRewrites: [
            { file: "src/ask/types/index.ts", from: "./chat", to: "@app/utils/ask/types/chat" },
            { file: "src/ask/types/index.ts", from: "./provider", to: "@app/utils/ask/types/provider" },
        ],
    },
    {
        id: "model-resolver",
        description: "ask/providers/ModelResolver (type-imported by utils/ai/AIAccount; closure = @ask/types only)",
        gitMoves: [
            { from: "src/ask/providers/ModelResolver.ts", to: "src/utils/ask/providers/ModelResolver.ts" },
            {
                from: "src/ask/providers/__tests__/ModelResolver.test.ts",
                to: "src/utils/ask/providers/__tests__/ModelResolver.test.ts",
            },
        ],
        specRewrites: [{ from: "@ask/providers/ModelResolver", to: "@app/utils/ask/providers/ModelResolver" }],
        fileRewrites: [
            {
                file: "src/ask/index.lib.ts",
                from: "./providers/ModelResolver",
                to: "@app/utils/ask/providers/ModelResolver",
            },
            // Runs after the ask-types move's utils-scoped barrel rewrite, so fix its own import here.
            { file: "src/utils/ask/providers/ModelResolver.ts", from: "@ask/types", to: "@app/utils/ask/types" },
        ],
    },
    {
        id: "audio-processor",
        description:
            "ask/audio/AudioProcessor (runtime-imported by utils/ai/tasks/Transcriber; closure = utils/audio only)",
        gitMoves: [{ from: "src/ask/audio/AudioProcessor.ts", to: "src/utils/ask/audio/AudioProcessor.ts" }],
        specRewrites: [{ from: "@app/ask/audio/AudioProcessor", to: "@app/utils/ask/audio/AudioProcessor" }],
    },
    {
        id: "github-types",
        description: "github/types.ts (583 lines pure types, imported by utils/github)",
        gitMoves: [{ from: "src/github/types.ts", to: "src/utils/github/types.ts" }],
        specRewrites: [{ from: "@app/github/types", to: "@app/utils/github/types" }],
    },
    {
        id: "macos-mail",
        description: "macos/lib/mail/{constants,db-types,types} (the three files utils/macos/MailDatabase imports)",
        gitMoves: [
            { from: "src/macos/lib/mail/constants.ts", to: "src/utils/macos/mail/constants.ts" },
            { from: "src/macos/lib/mail/db-types.ts", to: "src/utils/macos/mail/db-types.ts" },
            { from: "src/macos/lib/mail/types.ts", to: "src/utils/macos/mail/types.ts" },
        ],
        specRewrites: [
            { from: "@app/macos/lib/mail/constants", to: "@app/utils/macos/mail/constants" },
            { from: "@app/macos/lib/mail/db-types", to: "@app/utils/macos/mail/db-types" },
            { from: "@app/macos/lib/mail/types", to: "@app/utils/macos/mail/types" },
        ],
        fileRewrites: [
            { file: "src/macos/lib/mail/emlx.ts", from: "./constants", to: "@app/utils/macos/mail/constants" },
            { file: "src/macos/lib/mail/emlx.test.ts", from: "./constants", to: "@app/utils/macos/mail/constants" },
        ],
    },
    {
        id: "prompt-store",
        description: "doctor's opentui prompt-store (zustand only, fully generic) into utils/tui",
        gitMoves: [{ from: "src/doctor/ui/tui/stores/prompt-store.ts", to: "src/utils/tui/prompt-store.ts" }],
        specRewrites: [{ from: "@app/doctor/ui/tui/stores/prompt-store", to: "@app/utils/tui/prompt-store" }],
        fileRewrites: [
            {
                file: "src/doctor/ui/tui/PromptHost.tsx",
                from: "./stores/prompt-store",
                to: "@app/utils/tui/prompt-store",
            },
            { file: "src/doctor/ui/tui/App.tsx", from: "./stores/prompt-store", to: "@app/utils/tui/prompt-store" },
        ],
    },
    {
        id: "cmux-lib",
        description: "cmux protocol client (cli/controls/focus-guard/socket/live-snapshot, all imported by utils/cmux)",
        gitMoves: [
            { from: "src/cmux/lib/cli.ts", to: "src/utils/cmux/lib/cli.ts" },
            { from: "src/cmux/lib/controls.ts", to: "src/utils/cmux/lib/controls.ts" },
            { from: "src/cmux/lib/focus-guard.ts", to: "src/utils/cmux/lib/focus-guard.ts" },
            { from: "src/cmux/lib/socket.ts", to: "src/utils/cmux/lib/socket.ts" },
            { from: "src/cmux/lib/live-snapshot.ts", to: "src/utils/cmux/lib/live-snapshot.ts" },
            { from: "src/cmux/lib/live-snapshot.test.ts", to: "src/utils/cmux/lib/live-snapshot.test.ts" },
        ],
        specRewrites: [
            { from: "@app/cmux/lib/cli", to: "@app/utils/cmux/lib/cli" },
            { from: "@app/cmux/lib/controls", to: "@app/utils/cmux/lib/controls" },
            { from: "@app/cmux/lib/focus-guard", to: "@app/utils/cmux/lib/focus-guard" },
            { from: "@app/cmux/lib/socket", to: "@app/utils/cmux/lib/socket" },
            { from: "@app/cmux/lib/live-snapshot", to: "@app/utils/cmux/lib/live-snapshot" },
        ],
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
