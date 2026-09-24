#!/usr/bin/env bun
/**
 * Differential test for the diff hook: the OLD implementation (GenesisClaude) against the
 * NEW one, over a matrix of scenarios whose correct answer is known by construction.
 *
 * Every scenario builds a throwaway git repo under /tmp, runs the SAME pre phase for both
 * sides, mutates the tree exactly as a Bash command would, runs one post phase, and
 * compares the two renderings after normalisation.
 *
 * Read-only with respect to every real repository: it writes only under /tmp, and it points
 * GENESIS_TOOLS_HOME at a throwaway home so the real config is never read or written.
 *
 * Usage: bun scripts/hooks-diff-parity.ts [--verbose]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";

const OLD_POST = join(homedir(), ".claude", "hooks", "bash-edit-diff.ts");
const NEW_POST = "src/agents/bin/hook-diff-post.ts";
const NEW_PRE = "src/agents/bin/hook-diff-pre.ts";
const VERBOSE = process.argv.includes("--verbose");

interface Scenario {
    name: string;
    /** Runs BEFORE the pre phase. Sets up state the command did NOT create. */
    setup?: (root: string) => void;
    /** Stands in for the Bash command itself. */
    mutate: (root: string) => void;
    /** Paths the native renderer claims it already drew. */
    nativeFiles?: (root: string) => string[];
    /** Command text, for root discovery. */
    command?: (root: string) => string;
    /**
     * Why this scenario is EXPECTED to differ. Set only where the port deliberately fixes a
     * defect the old implementation still has; anything else diverging is a port bug.
     */
    expectedDivergence?: string;
}

function run(root: string, args: string[]): void {
    spawnSync(args[0] as string, args.slice(1), { cwd: root, encoding: "utf8" });
}

const SCENARIOS: Scenario[] = [
    {
        name: "tracked file, single change",
        mutate: (root) => writeFileSync(join(root, "kept.ts"), "alpha\nBRAVO\ncharlie\n"),
    },
    {
        name: "second command shows only its own change",
        setup: (root) => writeFileSync(join(root, "kept.ts"), "alpha\nFIRST\ncharlie\n"),
        mutate: (root) => writeFileSync(join(root, "kept.ts"), "alpha\nFIRST\nSECOND\n"),
    },
    {
        name: "pre-existing dirt is not blamed on this command",
        setup: (root) => writeFileSync(join(root, "kept.ts"), "alpha\nDIRTY\ncharlie\n"),
        mutate: (root) => writeFileSync(join(root, "other.ts"), "new file\n"),
    },
    { name: "new untracked file", mutate: (root) => writeFileSync(join(root, "fresh.ts"), "one\ntwo\n") },
    {
        name: "second edit to an untracked file is a delta",
        setup: (root) => writeFileSync(join(root, "fresh.ts"), "one\ntwo\n"),
        mutate: (root) => writeFileSync(join(root, "fresh.ts"), "one\nTWO-EDITED\n"),
    },
    {
        name: "edit inside a wholly untracked directory",
        setup: (root) => {
            mkdirSync(join(root, "scratch"), { recursive: true });
            writeFileSync(join(root, "scratch/a.ts"), "one\ntwo\n");
        },
        mutate: (root) => writeFileSync(join(root, "scratch/a.ts"), "one\nTWO-EDITED\n"),
    },
    { name: "staged deletion", mutate: (root) => run(root, ["git", "rm", "-qf", "kept.ts"]) },
    { name: "no change at all", mutate: () => {} },
    {
        name: "native already covered the file",
        mutate: (root) => writeFileSync(join(root, "kept.ts"), "alpha\nCOVERED\ncharlie\n"),
        nativeFiles: (root) => [join(root, "kept.ts")],
    },
    {
        name: "native payload present but empty",
        mutate: (root) => writeFileSync(join(root, "kept.ts"), "alpha\nEMPTYPAYLOAD\ncharlie\n"),
        nativeFiles: () => [],
    },
    {
        // `git status --porcelain` QUOTES a path with a space, and the pre phase feeds those
        // lines to `tar -T -`. A quoted name that tar cannot find is the shape that turns a
        // real edit into a silent hook.
        name: "a tracked path with a space in its name",
        setup: (root) => writeFileSync(join(root, "a file.ts"), "one\ntwo\n"),
        mutate: (root) => writeFileSync(join(root, "a file.ts"), "one\nTWO-EDITED\n"),
        expectedDivergence:
            "the old hook goes silent on a C-quoted path; the port reads `--porcelain -z`, which never quotes",
    },
    {
        name: "a dirty tree with many other changed files",
        setup: (root) => {
            for (let index = 0; index < 25; index++) {
                writeFileSync(join(root, `noise-${index}.ts`), `noise ${index}\n`);
            }
        },
        mutate: (root) => writeFileSync(join(root, "kept.ts"), "alpha\nAMONG-NOISE\ncharlie\n"),
    },
];

/**
 * Raw output cannot be compared directly: it carries absolute tmp paths that differ per run
 * and ANSI colour that differs when `bat` is present on one path and not the other.
 */
function normalise(message: string | null, root: string): string {
    if (!message) {
        return "<silent>";
    }

    return stripAnsi(message)
        .split(root)
        .join("<ROOT>")
        .replace(/[ \t]+$/gm, "")
        .trim();
}

function makeRepo(): string {
    // `mkdtempSync` + `realpathSync`, never `mktemp`/`realpath` through a child: an empty
    // stdout from either would make `join(root, "kept.ts")` collapse to a RELATIVE
    // `kept.ts`, and this harness would then write its fixtures into the repository it is
    // run from. macOS also symlinks /tmp, so the realpath step is not optional.
    const real = realpathSync(mkdtempSync(join(tmpdir(), "gt-diffparity-")));

    run(real, ["git", "init", "-q"]);
    run(real, ["git", "config", "user.email", "probe@local"]);
    run(real, ["git", "config", "user.name", "probe"]);
    writeFileSync(join(real, "kept.ts"), "alpha\nbravo\ncharlie\n");
    run(real, ["git", "add", "-A"]);
    run(real, ["git", "commit", "-qm", "init"]);

    return real;
}

/** A throwaway tool home, so the real `~/.genesis-tools` is neither read nor written. */
function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "gt-diffparity-home-"));

    mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
    writeFileSync(
        join(home, ".genesis-tools", "agents", "hooks.json"),
        SafeJSON.stringify({ shadow: false, diff: { highlight: "none" } })
    );

    return home;
}

let calls = 0;

function runOne(scenario: Scenario, post: string, home: string): { root: string; output: string } {
    calls += 1;

    const root = makeRepo();
    const session = "diff-parity";
    const toolUseId = `call-${calls}`;
    const command = scenario.command?.(root) ?? "true";
    // `TMPDIR=/tmp` pins BOTH implementations to the same capture tree: the port derives it
    // from `tmpdir()`, while the hook it replaces has `/tmp/GenesisTools/...` hardcoded.
    // Without this the two would read different directories and every scenario would look
    // like a divergence that is really just two paths.
    const env = { ...process.env, GENESIS_TOOLS_HOME: home, TMPDIR: "/tmp" };
    const base = {
        tool_name: "Bash",
        cwd: root,
        session_id: session,
        tool_use_id: toolUseId,
        tool_input: { command },
    };

    scenario.setup?.(root);

    // The SAME pre phase feeds both sides: the layout under /tmp/GenesisTools is identical,
    // so a divergence can only come from the post phase, which is what is under test.
    const pre = spawnSync("bun", [NEW_PRE], {
        input: SafeJSON.stringify({ ...base, hook_event_name: "PreToolUse" }),
        encoding: "utf8",
        env,
    });

    // A pre phase that crashed writes no capture, and both post phases then fall back the same
    // way, which scored as a MATCH. It is a harness failure, not a result.
    if (pre.status !== 0) {
        throw new Error(
            `pre phase failed for "${scenario.name}" (exit ${pre.status ?? pre.signal}): ${(pre.stderr ?? "").slice(0, 2000)}`
        );
    }

    scenario.mutate(root);

    const native = scenario.nativeFiles?.(root);
    const response =
        native === undefined
            ? { stdout: "" }
            : { stdout: "", bashEditDiff: { files: native.map((filePath) => ({ filePath })) } };
    const child = spawnSync("bun", [post], {
        input: SafeJSON.stringify({ ...base, hook_event_name: "PostToolUse", tool_response: response }),
        encoding: "utf8",
        env,
        maxBuffer: 64_000_000,
    });

    // A crashed post phase printed nothing, which normalised to `<silent>` and matched every
    // "no change" expectation. Its failure is its own output, so the comparison sees it.
    if (child.status !== 0) {
        return { root, output: `<exit ${child.status ?? child.signal}> ${(child.stderr ?? "").slice(0, 500)}` };
    }

    const stdout = (child.stdout ?? "").trim();
    let message: string | null = null;

    if (stdout.length > 0) {
        try {
            message = (SafeJSON.parse(stdout, { strict: true }) as { systemMessage?: string }).systemMessage ?? null;
        } catch {
            message = stdout;
        }
    }

    return { root, output: normalise(message, root) };
}

const home = makeHome();
const mismatches: { name: string; oldOut: string; newOut: string }[] = [];
const expected: { name: string; why: string; oldOut: string; newOut: string }[] = [];
const unmetExpectations: string[] = [];

for (const scenario of SCENARIOS) {
    const before = runOne(scenario, OLD_POST, home);
    const after = runOne(scenario, NEW_POST, home);

    if (VERBOSE) {
        out.println(`--- ${scenario.name}`);
        out.println(`old: ${before.output.split("\n")[0]}`);
        out.println(`new: ${after.output.split("\n")[0]}`);
    }

    const differs = before.output !== after.output;

    if (differs && scenario.expectedDivergence) {
        expected.push({
            name: scenario.name,
            why: scenario.expectedDivergence,
            oldOut: before.output,
            newOut: after.output,
        });
    } else if (differs) {
        mismatches.push({ name: scenario.name, oldOut: before.output, newOut: after.output });
    } else if (scenario.expectedDivergence) {
        // The fix stopped working, or the old implementation caught up. Either way the note
        // is now false, and a stale expectation is how a real regression hides.
        unmetExpectations.push(scenario.name);
    }

    rmSync(before.root, { recursive: true, force: true });
    rmSync(after.root, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });

out.println(`${SCENARIOS.length} scenarios, mismatches: ${mismatches.length}`);
out.println(`expected divergences: ${expected.length}`);

for (const row of expected) {
    out.println(`  ✎ ${row.name}: ${row.why}`);
    out.println(`      old: ${row.oldOut.split("\n")[0]}`);
    out.println(`      new: ${row.newOut.split("\n")[0]}`);
}

for (const name of unmetExpectations) {
    out.println(`  ! ${name} was marked as an expected divergence but the two now agree`);
}

for (const row of mismatches) {
    out.println("");
    out.println(`✗ ${row.name}`);
    out.println(`  old:\n${row.oldOut.replace(/^/gm, "    ")}`);
    out.println(`  new:\n${row.newOut.replace(/^/gm, "    ")}`);
}

process.exit(mismatches.length === 0 && unmetExpectations.length === 0 ? 0 : 1);
