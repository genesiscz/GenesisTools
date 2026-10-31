#!/usr/bin/env bun
/**
 * The extensibility proof of the harness drivers (plan `.claude/plans/2026-10-30-PlugenizeHarnesses.md`, P8): add a
 * fourth harness, `testbot`, to a scratch worktree of this checkout and measure what it costs.
 *
 * 1. The plant: the alias in `alias-list.ts` (the `HarnessId` type) and its `byHarness` row, one `DRIVERS` entry in
 *    `harness-index.ts`, one `HOOKS` entry in `harness-hooks.ts`, and the plugin folder
 *    `src/utils/ai/providers/plugins/testbot-sub/` with its driver (identity, launch, a locator over a fixture folder;
 *    the parts the probe does not run are borrowed from the Codex driver, where a real harness writes its own).
 *    Beside it, `note-probe.ts` puts a note (`{ note: true, reason }`) in place of each part in turn: the compiler must
 *    refuse every one, so a fourth harness has to write each part's code, its history reader included, not a note.
 * 2. The seam: `tsgo` lists every file the compiler then refuses. A file is expected when it is a driver-side owner
 *    (the plugin folders, `src/utils/harness/`, the light doors), a test, or an allowlist entry of the harness guard
 *    that says why it keeps a table keyed by the harness type. Any other file is a seam a new harness would have to
 *    find by hand, and the run exits 1 naming it.
 * 3. The runtime: inside the worktree, `resolveTranscript` finds a testbot session through the driver's locator, and
 *    `harnessLaunch` builds its resume argv.
 *
 *   bun scripts/ci/harness-extensibility.ts
 *
 * The worktree goes under `HARNESS_EXTENSIBILITY_DIR` (default: `harness-extensibility` in the temp folder). The run
 * never deletes it: it prints the `git worktree remove` command, and it refuses to start while an earlier worktree is
 * still there.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_PARTS } from "@genesiscz/utils/harness/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { HARNESS_GUARD_ALLOWLIST } from "./harness-guard-allowlist";

const REPO = join(import.meta.dirname, "..", "..");
const BASE = process.env.HARNESS_EXTENSIBILITY_DIR ?? join(tmpdir(), "harness-extensibility");
const WORKTREE = join(BASE, "wt");

/** Files a new harness is meant to touch: the drivers, the canonical list, the light doors, tests, generated code. */
const EXPECTED_OWNERS =
    /^(?:src\/utils\/harness\/|src\/utils\/ai\/providers\/(?:plugins\/|alias-list\.ts$|harness-index\.ts$|harness-hooks\.ts$))|\.test\.tsx?$|(?:^|\/)(?:testing|fixtures?)\//;

function run(command: string[], cwd: string): { status: number; out: string } {
    const proc = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
    return { status: proc.exitCode ?? 1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

/** Replace `needle` in `file` (under the worktree) once; throws when the needle is not there, so a moved anchor fails. */
function plant(file: string, needle: string, replacement: string): void {
    const path = join(WORKTREE, file);
    const text = readFileSync(path, "utf8");

    if (!text.includes(needle)) {
        throw new Error(`harness-extensibility: ${file} no longer holds the anchor ${SafeJSON.stringify(needle)}`);
    }

    writeFileSync(path, text.replace(needle, replacement));
}

const TESTBOT_DRIVER = `import { join } from "node:path";
import type { HarnessDriver } from "@genesiscz/utils/harness/types";
import { codexHarness } from "../openai-sub/harness";

/**
 * The testbot driver of scripts/ci/harness-extensibility.ts: a launch recipe and a locator over TESTBOT_HOME. The parts
 * the probe does not run are the Codex driver's; a real harness writes its own.
 */
export const testbotHarness: HarnessDriver<"testbot"> = {
    id: "testbot",
    identity: {
        label: "Testbot",
        binary: "testbot",
        plugin: "testbot-sub",
        aliases: ["testbot-cli"],
        vendor: "Example",
        mark: { letter: "T", color: { red: 0.5, green: 0.5, blue: 0.5 }, logo: null },
    },
    parts: {
        ...codexHarness.parts,
        dialog: { supported: false, reason: "testbot has no question dialog" },
        launch: {
            resumeArgv: (sessionId) => ["testbot", "--resume", sessionId],
            startArgv: () => ["testbot"],
            startPinsAccount: false,
            cmuxOpenSession: false,
            resumeFlags: { "--model": "value" },
            resumeSyntax: { flags: ["--resume"], subcommand: false, render: (sessionId) => \`--resume \${sessionId}\` },
        },
        locate: {
            defaultRoots: () => ({ native: [process.env.TESTBOT_HOME ?? "/nonexistent"], worker: "/nonexistent" }),
            pathRoots: () => [{ root: process.env.TESTBOT_HOME ?? "/nonexistent", source: "native" }],
            sessionOfPath: ({ source, stem, filePath }) => ({ provider: "testbot", source, sessionId: stem, filePath }),
            find: (query, _roots, fs) => {
                const home = process.env.TESTBOT_HOME ?? "/nonexistent";
                return fs
                    .listDir(home)
                    .filter((name) => name === \`\${query}.jsonl\`)
                    .map((name) => ({
                        provider: "testbot" as const,
                        source: "native" as const,
                        sessionId: query,
                        filePath: join(home, name),
                        mtime: fs.mtimeOf(join(home, name)),
                    }));
            },
            workerNative: () => null,
            titledSessions: () => [],
            rootsOfHome: () => ({}),
        },
    },
};
`;

/** One line per part, each putting a note where that part's code belongs; the compiler must refuse every line. */
const NOTE_PROBE = `import type { HarnessParts } from "@genesiscz/utils/harness/types";
import { codexHarness } from "../openai-sub/harness";

const note = { note: true, reason: "testbot has no such part" } as const;

${HARNESS_PARTS.map((part) => `export const ${part}AsNote: HarnessParts = { ...codexHarness.parts, ${part}: note };`).join("\n")}
`;
const NOTE_PROBE_FILE = "src/utils/ai/providers/plugins/testbot-sub/note-probe.ts";
/** The 1-based line of the first part's note in `NOTE_PROBE`. */
const NOTE_PROBE_FIRST_LINE = 6;

export function compilerProbeUsable(result: { status: number; out: string }): boolean {
    return (
        (result.status === 1 || result.status === 2) &&
        /^[^\s(]+\.tsx?\(\d+,\d+\): error TS/m.test(result.out) &&
        !/^error TS\d+:/m.test(result.out)
    );
}

function main(): void {
    if (existsSync(WORKTREE)) {
        console.error(`harness-extensibility: ${WORKTREE} exists from an earlier run; inspect it, then run:`);
        console.error(`    git -C ${REPO} worktree remove ${WORKTREE}`);
        process.exitCode = 2;
        return;
    }

    mkdirSync(BASE, { recursive: true });
    const added = run(["git", "worktree", "add", "--detach", WORKTREE, "HEAD"], REPO);

    if (added.status !== 0) {
        console.error(`harness-extensibility: git worktree add failed:\n${added.out}`);
        process.exitCode = 2;
        return;
    }

    // The checkout's own dependency tree, so the worktree resolves imports without an install.
    // The repository's post-checkout hook may have installed one already; then that one is used.
    if (!existsSync(join(WORKTREE, "node_modules"))) {
        symlinkSync(join(REPO, "node_modules"), join(WORKTREE, "node_modules"));
    }

    plant(
        "src/utils/ai/providers/alias-list.ts",
        'export const ACCOUNT_PROVIDER_ALIASES = ["claude", "codex", "grok"] as const;',
        'export const ACCOUNT_PROVIDER_ALIASES = ["claude", "codex", "grok", "testbot"] as const;'
    );
    plant(
        "src/utils/ai/providers/alias-list.ts",
        'return { claude: pick("claude"), codex: pick("codex"), grok: pick("grok") };',
        'return { claude: pick("claude"), codex: pick("codex"), grok: pick("grok"), testbot: pick("testbot") };'
    );
    plant(
        "src/utils/ai/providers/harness-index.ts",
        "    grok: grokHarness,\n};",
        "    grok: grokHarness,\n    testbot: testbotHarness,\n};"
    );
    plant(
        "src/utils/ai/providers/harness-index.ts",
        'import { codexHarness } from "./plugins/openai-sub/harness";',
        'import { codexHarness } from "./plugins/openai-sub/harness";\nimport { testbotHarness } from "./plugins/testbot-sub/harness";'
    );
    plant(
        "src/utils/ai/providers/harness-hooks.ts",
        "    grok: grokHooks,\n};",
        "    grok: grokHooks,\n    testbot: { ...codexHooks },\n};"
    );
    mkdirSync(join(WORKTREE, "src/utils/ai/providers/plugins/testbot-sub"), { recursive: true });
    writeFileSync(join(WORKTREE, "src/utils/ai/providers/plugins/testbot-sub/harness.ts"), TESTBOT_DRIVER);
    writeFileSync(join(WORKTREE, NOTE_PROBE_FILE), NOTE_PROBE);

    // 2. The seam the compiler names.
    const typed = run(["bunx", "tsgo", "--noEmit", "-p", "tsconfig.json"], WORKTREE);
    if (!compilerProbeUsable(typed)) {
        console.error(`harness-extensibility: compiler probe failed (exit ${typed.status}):\n${typed.out}`);
        process.exitCode = 2;
        return;
    }
    const named = [
        ...new Set([...typed.out.matchAll(/^([^\s(]+\.tsx?)\(\d+,\d+\): error TS/gm)].map((m) => m[1])),
    ].sort();
    const unexpected = named.filter((file) => !EXPECTED_OWNERS.test(file) && !HARNESS_GUARD_ALLOWLIST[file]?.why);
    const refusedLines = new Set(
        [...typed.out.matchAll(/^([^\s(]+\.tsx?)\((\d+),\d+\): error TS/gm)]
            .filter((m) => m[1] === NOTE_PROBE_FILE)
            .map((m) => Number(m[2]))
    );
    const notesAccepted = HARNESS_PARTS.filter((_, index) => !refusedLines.has(NOTE_PROBE_FIRST_LINE + index));

    console.log(
        notesAccepted.length === 0
            ? `harness-extensibility: the compiler refuses a note in place of each of the ${HARNESS_PARTS.length} parts`
            : `harness-extensibility: a note still type-checks in place of: ${notesAccepted.join(", ")}`
    );

    console.log(`harness-extensibility: the compiler names ${named.length} files for a fourth harness`);

    for (const file of named) {
        const how = EXPECTED_OWNERS.test(file)
            ? "owner"
            : HARNESS_GUARD_ALLOWLIST[file]?.why
              ? `justified: ${HARNESS_GUARD_ALLOWLIST[file]?.why}`
              : "UNEXPECTED";
        console.log(`    ${file}  (${how})`);
    }

    // 3. The runtime through the testbot driver.
    const fixture = join(BASE, "home");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "testbot-session-1.jsonl"), "{}\n");
    const probe = Bun.spawnSync(
        [
            "bun",
            "-e",
            [
                'const { resolveTranscript } = await import("@genesiscz/utils/ai/transcripts/resolve");',
                'const { harnessLaunch } = await import("@genesiscz/utils/ai/providers/harness-index");',
                'const hit = await resolveTranscript("testbot-session-1", {}, "testbot");',
                'console.log(JSON.stringify({ hit, argv: harnessLaunch("testbot").resumeArgv("s-1", {}) }));',
            ].join("\n"),
        ],
        { cwd: WORKTREE, env: { ...process.env, TESTBOT_HOME: fixture }, stdout: "pipe", stderr: "pipe" }
    );
    const runtimeOut = probe.stdout.toString().trim();
    const runtimeOk =
        probe.exitCode === 0 &&
        runtimeOut.includes('"provider":"testbot"') &&
        runtimeOut.includes('"argv":["testbot","--resume","s-1"]');

    console.log(
        `harness-extensibility: runtime ${runtimeOk ? "OK" : "FAILED"}: ${runtimeOut || probe.stderr.toString().trim()}`
    );
    console.log(`harness-extensibility: worktree kept for inspection; remove it with:`);
    console.log(`    git -C ${REPO} worktree remove --force ${WORKTREE}`);

    if (unexpected.length > 0 || !runtimeOk || notesAccepted.length > 0) {
        console.log(
            `harness-extensibility: FAILED (${unexpected.length} unexpected files, ${notesAccepted.length} parts that take a note)`
        );
        process.exitCode = 1;
        return;
    }

    console.log("harness-extensibility: OK");
}

if (import.meta.main) {
    main();
}
