/**
 * Template for a throwaway sweep SCRIPT. You rarely need one: for literal edits,
 * inserts, appends and new files the CLI is one call with no code at all —
 *
 *   bun "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/cli.ts" <<'EOF'
 *   @@ src/foo.ts
 *   <<<
 *   old text
 *   ===
 *   new text
 *   >>>
 *   EOF
 *
 * Reach for a script when you need recon (findFiles / countMatches / grepPreview),
 * a cross-file rename with pinned counts, comment sweeps, or a replacer FUNCTION.
 * Every multi-input function takes ONE object; `bun cli.ts --api` prints every
 * signature with its docs.
 *
 *   bun <your-script>.ts --dry   # preview diffs, writes nothing
 *   bun <your-script>.ts         # transactional apply (all-or-nothing)
 *
 * 🛑 Never a hard-coded generic /tmp path for backupDir or logs: /tmp is shared
 * machine-wide and two parallel agents overwrote each other's evidence. scratchDir().
 */
import {
    all,
    countMatches,
    drop,
    dropJsdocStarting,
    findFiles,
    grepPreview,
    leftovers,
    maybe,
    mergeFileEdits,
    renameSymbolAcross,
    run,
    sameOpsAcross,
    scratchDir,
} from "./replace-utils";

// A copy of this template that lives elsewhere imports from
// "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/replace-utils" instead.

const scratch = scratchDir("my-sweep");

// ── recon, entirely inside the API ───────────────────────────────────────────
const targets = findFiles({ roots: ["src"], containing: /\boldName\b/ });
const EXPECT = countMatches({ files: targets, pattern: "oldName" }); // paste-ready counts + zero-match and shadowing warnings
grepPreview({ files: targets.slice(0, 3), pattern: /oldName(?=\()/, context: 2 });

await run({
    edits: [
        {
            file: "src/some/File.ts",
            ops: [
                { find: `const x = oldName(y);`, replace: `const x = newName(y);` }, // exactly once (default)
                all({ find: "oldName(", replace: "newName(" }), // every occurrence
                dropJsdocStarting({ fromPrefix: "/**\n * Legacy parity" }), // delete a JSDoc by its opening lines
                maybe({ find: "// TODO remove me\n", replace: "" }), // fine if already gone on a re-run
                { kind: "regex", find: /useFoo\(([^)]*)\)/g, replace: "useBar($1)", expect: 3 }, // pinned match count
                {
                    kind: "insertLinesAfter",
                    anchor: `import React from "react";`,
                    text: `import { thing } from "pkg";`,
                },
                { kind: "append", text: "export {};" },
            ],
            expectAfter: ["newName"],
            absentAfter: ["oldName"],
        },

        // Comment sweep: the COMMENT goes, code on the same line stays (deleteLines would
        // delete the whole statement). One expect per file, from the countMatches map.
        ...Object.entries(EXPECT).map(([file, n]) => ({
            file,
            ops: [{ kind: "dropComments" as const, containing: "eslint-disable", expect: n }],
        })),

        // Identical counts → one shared op list is safe:
        ...sameOpsAcross({
            files: ["src/a.tsx", "src/b.tsx"],
            ops: [{ kind: "deleteLines", containing: "console.debug(" }],
        }),

        // Cross-file identifier rename, word-boundary anchored. Pass the countMatches map
        // to pin every count; mergeFileEdits lets two renames share files.
        ...mergeFileEdits([
            ...renameSymbolAcross({ files: EXPECT, oldName: "oldName", newName: "newName" }),
            ...renameSymbolAcross({
                files: findFiles({ roots: ["src"], containing: /\botherName\b/ }),
                oldName: "otherName",
                newName: "renamedOther",
            }),
        ]),

        { file: "src/dead/Orphan.ts", delete: true },
        { file: "src/old/Path.ts", renameTo: "src/new/Path.ts" },
        { file: "src/two.ts", ops: [drop({ find: "// old comment\n" })] },
    ],
    backupDir: scratch, // one per sweep, never reused; the scratch dir ITSELF, so the age prune can reclaim it
    verifyCommand: "bunx tsgo --noEmit", // proves completeness; red keeps the writes and throws code 3 (rollback({ backupDir }) undoes)
    leftoversCheck: { names: ["oldName"], dirs: ["."] }, // a rename is not done while docs still say oldName
});

leftovers({ names: ["oldName"], dirs: ["src", "docs", "README.md"] });
