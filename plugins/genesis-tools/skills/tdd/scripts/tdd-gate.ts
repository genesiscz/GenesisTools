#!/usr/bin/env bun

/**
 * tdd-gate — mechanizes three of the five TDD gates from the genesis-tools:tdd skill.
 *
 *   red    : run the test command, tee full output to the session dir, record the exit code,
 *            snapshot the test file(s) and any existing .snap files, print failure lines ready
 *            for verbatim quoting. Exits loudly when the test PASSES (no-RED branch), warns when
 *            the failure is a load/setup error rather than a witnessed assertion failure.
 *   green  : refuses a command different from the one RED witnessed, then the weakened-assertion
 *            guard (diff test files vs the RED snapshot; edits that remove/change an assertion,
 *            skip/isolate a test, or change literal values can never be allowed —
 *            --allow-test-edit "<reason>" covers only edits that cannot change whether the test
 *            passes), then the flake gate (run the command TWICE; disagreement means FLAKY), a
 *            snapshot-file check scoped to the guarded tests' .snap files, and an executed-test
 *            count comparison vs RED (a skipped test is not a passing test).
 *   report : print the paste-ready evidence block (every completed slice, RED verbatim, GREEN 2x,
 *            guard status incl. allowed-edit diffs). Exits nonzero unless GREEN passed cleanly.
 *   clean  : remove one session dir; requires an explicit --session.
 *
 * Sessions live at ~/.genesis-tools/tdd/sessions/<name>/. Default name at red: the sanitized git
 * branch, else a timestamp. green/report resolve: --session, else the session the last `red`
 * wrote from this working directory (per-cwd .last pointer), else the branch session, else the
 * most recently touched one — green prints the binding (session, red cmd, guarded files) so a
 * wrong resolution is visible.
 *
 * Exit codes: 0 ok · 1 no-RED at red, or tests failed at green, or report on an incomplete/failed
 * cycle · 2 usage, missing state, signal-killed command, or command mismatch · 3 guard tripped
 * (test-file edit, assertion/skip/value change, snapshot-file change, or fewer executed tests) ·
 * 4 flaky (the two runs disagreed).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

interface SnapshotEntry {
    path: string;
    snapshot: string;
}

interface SnapFileRecord {
    path: string;
    hash: string;
}

interface RedRecord {
    cmd: string;
    exitCode: number;
    ts: string;
    logFile: string;
    failureLines: string[];
    noRed: boolean;
    errorNotAssertion?: boolean;
    counts?: { executed: number; skipped: number } | null;
}

interface GreenRunRecord {
    exitCode: number;
    ts: string;
    logFile: string;
}

interface GreenRecord {
    cmd: string;
    runs: [GreenRunRecord, GreenRunRecord];
    flaky: boolean;
    guard: "clean" | "edited-allowed";
    snapViolations?: string[];
    countViolation?: string | null;
    ts: string;
}

interface AllowedEdit {
    reason: string;
    ts: string;
    files: string[];
    removedLines?: string[];
    addedLines?: string[];
}

interface CycleRecord {
    red: RedRecord;
    green: GreenRecord;
}

interface SessionState {
    session: string;
    createdTs: string;
    testFiles: SnapshotEntry[];
    allowedEdits: AllowedEdit[];
    snapFiles?: SnapFileRecord[];
    history?: CycleRecord[];
    red?: RedRecord;
    green?: GreenRecord;
}

// This script must also run from a plugin-cache copy (Claude plugin cache, ~/.grok/skills) where the
// repo's node_modules is absent, so it cannot import @genesiscz/utils/env. TOOLS_HOME mirrors
// env.tools.getHome() exactly: GENESIS_TOOLS_HOME (the sandbox root) ?? homedir(), with callers
// appending ".genesis-tools" themselves. TDD_GATE_SESSIONS_ROOT is the test-only override.
// lint-rules-ignore: standalone script without access to @genesiscz/utils/env
const TOOLS_HOME = process.env.GENESIS_TOOLS_HOME?.trim() || homedir();
const SESSIONS_ROOT = process.env.TDD_GATE_SESSIONS_ROOT ?? join(TOOLS_HOME, ".genesis-tools", "tdd", "sessions");
const STATE_FILE = "state.json";
const LAST_POINTER = ".last";
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const FAILURE_RE =
    /✗|✘|✖|\bnot ok\b|\bfail(s|ed|ing)?\b|\berror\b|\bexpect(ed)?\b|\breceived\b|\bassert\w*\b|\bthrow\w*\b/i;
const LOAD_ERROR_RE = /Cannot find module|SyntaxError|ReferenceError|Unhandled error between tests|error TS\d+/;
const ASSERTION_OUTPUT_RE = /expect\(received\)|Expected[:\s]|AssertionError|\(fail\)/;
const ASSERTION_LINE_RE = /\b(expect|assert\w*|should)\b|\.to[A-Z]\w*\(/;
const SKIP_RE = /\b(test|it|describe)\s*\.\s*(skip|todo|only)\b|^\s*x(test|it|describe)\b/;

interface TestCounts {
    executed: number;
    skipped: number;
}

function extractTestCounts(output: string): TestCounts | null {
    const clean = output.replace(ANSI_RE, "");
    const pass = clean.match(/(\d+)\s+pass(?:ed)?\b/i);
    const fail = clean.match(/(\d+)\s+fail(?:ed)?\b/i);
    if (pass === null && fail === null) {
        return null;
    }

    const skip = clean.match(/(\d+)\s+skip(?:ped)?\b/i);
    return { executed: Number(pass?.[1] ?? 0) + Number(fail?.[1] ?? 0), skipped: Number(skip?.[1] ?? 0) };
}

function literalFingerprint(lines: string[]): string {
    const literals: string[] = [];
    for (const line of lines) {
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*import\b/.test(code) || /\brequire\s*\(/.test(code)) {
            continue;
        }

        literals.push(...(code.match(/\d+(?:\.\d+)?|"[^"]*"|'[^']*'|`[^`]*`/g) ?? []));
    }

    return literals.sort().join("|");
}

function parseJson<T>(text: string): T {
    // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
    return JSON.parse(text);
}

function stringifyJson(value: unknown): string {
    // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
    return JSON.stringify(value, null, 2);
}

function sanitizeName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned === "" ? "default" : cleaned;
}

function gitBranch(): string | null {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
        return null;
    }

    const branch = proc.stdout.toString().trim();
    if (branch === "" || branch === "HEAD") {
        return null;
    }

    return sanitizeName(branch);
}

function mostRecentSession(): string | null {
    if (!existsSync(SESSIONS_ROOT)) {
        return null;
    }

    let best: { name: string; mtime: number } | null = null;
    for (const entry of readdirSync(SESSIONS_ROOT)) {
        const dir = join(SESSIONS_ROOT, entry);
        const stats = statSync(dir);
        if (!stats.isDirectory()) {
            continue;
        }

        if (best === null || stats.mtimeMs > best.mtime) {
            best = { name: entry, mtime: stats.mtimeMs };
        }
    }

    return best === null ? null : best.name;
}

function sessionDir(name: string): string {
    return join(SESSIONS_ROOT, sanitizeName(name));
}

interface LastPointerEntry {
    cwd: string;
    session: string;
}

function readLastPointerEntries(): LastPointerEntry[] {
    const pointerPath = join(SESSIONS_ROOT, LAST_POINTER);
    if (!existsSync(pointerPath)) {
        return [];
    }

    try {
        const parsed = parseJson<LastPointerEntry[]>(readFileSync(pointerPath, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error(`⚠️  ignoring corrupt sessions/${LAST_POINTER} pointer: ${String(error)}`);
        return [];
    }
}

function writeLastPointer(session: string): void {
    const cwd = process.cwd();
    const entries = readLastPointerEntries().filter((entry) => entry.cwd !== cwd);
    entries.unshift({ cwd, session });
    writeFileSync(join(SESSIONS_ROOT, LAST_POINTER), stringifyJson(entries.slice(0, 50)));
}

function readLastPointer(): string | null {
    const entries = readLastPointerEntries();
    const forCwd = entries.find((entry) => entry.cwd === process.cwd());
    return forCwd?.session ?? null;
}

function hasState(name: string): boolean {
    return existsSync(join(sessionDir(name), STATE_FILE));
}

function resolveExistingSession(explicit: string | undefined): string | null {
    if (explicit !== undefined) {
        return sanitizeName(explicit);
    }

    const last = readLastPointer();
    if (last !== null && hasState(last)) {
        return last;
    }

    const branch = gitBranch();
    if (branch !== null && hasState(branch)) {
        return branch;
    }

    return mostRecentSession();
}

function loadState(name: string): SessionState | null {
    const statePath = join(sessionDir(name), STATE_FILE);
    if (!existsSync(statePath)) {
        return null;
    }

    return parseJson(readFileSync(statePath, "utf8"));
}

function saveState(state: SessionState): void {
    writeFileSync(join(sessionDir(state.session), STATE_FILE), stringifyJson(state));
}

function runShell(cmd: string, logPath: string): { exitCode: number; output: string; signaled: boolean } {
    const proc = Bun.spawnSync(["sh", "-c", `${cmd} 2>&1`], { stdout: "pipe", stderr: "pipe" });
    const output = proc.stdout.toString() + proc.stderr.toString();
    writeFileSync(logPath, output);
    return { exitCode: proc.exitCode ?? -1, output, signaled: proc.exitCode === null };
}

function extractFailureLines(output: string): string[] {
    const lines = output.replace(ANSI_RE, "").split("\n");
    const matches = lines.filter((line) => FAILURE_RE.test(line)).slice(0, 40);
    if (matches.length > 0) {
        return matches;
    }

    return lines.filter((line) => line.trim() !== "").slice(-20);
}

function changedTestFiles(state: SessionState): string[] {
    const changed: string[] = [];
    for (const entry of state.testFiles) {
        const snapshotPath = join(sessionDir(state.session), entry.snapshot);
        const current = existsSync(entry.path) ? readFileSync(entry.path, "utf8") : "<file deleted>";
        const snapshot = readFileSync(snapshotPath, "utf8");
        if (current !== snapshot) {
            changed.push(entry.path);
        }
    }

    return changed;
}

function diffLines(before: string, after: string): { removed: string[]; added: string[] } {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const beforeSet = new Set(beforeLines);
    const afterSet = new Set(afterLines);
    return {
        removed: beforeLines.filter((line) => !afterSet.has(line) && line.trim() !== "").slice(0, 20),
        added: afterLines.filter((line) => !beforeSet.has(line) && line.trim() !== "").slice(0, 20),
    };
}

function scanSnapshotFiles(root: string): SnapFileRecord[] {
    const found: SnapFileRecord[] = [];
    const walk = (dir: string, depth: number): void => {
        if (depth > 8 || found.length >= 500) {
            return;
        }

        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }

            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.isFile() && (entry.name.endsWith(".snap") || basename(dir) === "__snapshots__")) {
                found.push({ path: full, hash: String(Bun.hash(readFileSync(full, "utf8"))) });
            }
        }
    };
    walk(root, 0);
    return found;
}

function usage(): void {
    console.error(
        [
            "Usage:",
            '  tdd-gate.ts red   --cmd "<test cmd>" --test-file <path> [--test-file <path>...] [--session <name>]',
            '  tdd-gate.ts green --cmd "<same cmd as red>" [--session <name>] [--allow-test-edit "<reason>"]',
            "                    (--allow-test-edit covers NON-assertion edits only)",
            "  tdd-gate.ts report [--session <name>]",
            "  tdd-gate.ts clean  --session <name>",
        ].join("\n")
    );
}

function cmdRed(cmd: string, testFiles: string[], explicitSession: string | undefined): number {
    const branch = gitBranch();
    const fallback = `s-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const session = explicitSession !== undefined ? sanitizeName(explicitSession) : (branch ?? fallback);
    const dir = sessionDir(session);
    mkdirSync(join(dir, "snapshots"), { recursive: true });

    const entries: SnapshotEntry[] = [];
    for (const [i, file] of testFiles.entries()) {
        const abs = resolve(file);
        if (!existsSync(abs)) {
            console.error(`🛑 test file not found: ${abs}`);
            return 2;
        }

        const snapshot = join("snapshots", `${i}-${basename(abs)}`);
        writeFileSync(join(dir, snapshot), readFileSync(abs, "utf8"));
        entries.push({ path: abs, snapshot });
    }

    const previous = loadState(session);
    if (previous?.red !== undefined && previous.red.cmd !== cmd) {
        console.error(`⚠️  session "${session}" already holds a RED for a different command:`);
        console.error(`    recorded: ${previous.red.cmd}`);
        console.error(`    now:      ${cmd}`);
        console.error("    A different task belongs in its own --session; continuing overwrites this one.");
    }

    const history = [...(previous?.history ?? [])];
    if (previous?.red !== undefined && previous.green !== undefined) {
        history.push({ red: previous.red, green: previous.green });
    }

    const { exitCode, output, signaled } = runShell(cmd, join(dir, "red.log"));
    if (signaled) {
        console.error("🛑 the test command was killed by a signal (timeout? OOM?). That is not a RED.");
        console.error("Nothing was recorded. Fix the environment and re-run `red`.");
        return 2;
    }

    const failureLines = extractFailureLines(output);
    const noRed = exitCode === 0;
    const errorNotAssertion = !noRed && LOAD_ERROR_RE.test(output) && !ASSERTION_OUTPUT_RE.test(output);
    const state: SessionState = {
        session,
        createdTs: previous?.createdTs ?? new Date().toISOString(),
        testFiles: entries,
        allowedEdits: previous?.allowedEdits ?? [],
        snapFiles: scanSnapshotFiles(process.cwd()),
        history,
        red: {
            cmd,
            exitCode,
            ts: new Date().toISOString(),
            logFile: "red.log",
            failureLines,
            noRed,
            errorNotAssertion,
            counts: extractTestCounts(output),
        },
    };
    saveState(state);
    writeLastPointer(session);

    console.log(`Session: ${session}`);
    console.log(`Full output: ${join(dir, "red.log")}`);

    if (noRed) {
        console.error("");
        console.error("🛑 NO RED — the test PASSED (exit 0). This is not a witnessed failure.");
        console.error("Do NOT proceed to GREEN. Follow the skill's no-RED branch:");
        console.error("  (a) the bug does not exist  (b) test conditions differ from the report  (c) already fixed");
        return 1;
    }

    console.log(`\nRED captured (exit ${exitCode}). Failure lines — quote these VERBATIM in your report:\n`);
    for (const line of failureLines) {
        console.log(`  ${line}`);
    }

    if (errorNotAssertion) {
        console.error("");
        console.error("⚠️  ERROR, NOT AN ASSERTION FAILURE — the suite failed to load or run (import/setup/compile).");
        console.error("Bugfix entry: this does not witness the bug — fix the setup and re-run `red`.");
        console.error(
            "Feature entry, module not created yet: this IS the expected first RED if it matches your prediction."
        );
    }

    return 0;
}

function cmdGreen(
    cmd: string,
    explicitSession: string | undefined,
    allowReason: string | undefined,
    testFileFlagUsed: boolean
): number {
    if (testFileFlagUsed) {
        console.error("🛑 --test-file is only valid on `red` — green reuses the RED snapshot list.");
        console.error("If the guarded files changed, re-run `red` with the new list.");
        return 2;
    }

    const session = resolveExistingSession(explicitSession);
    const state = session === null ? null : loadState(session);
    if (session === null || state === null || state.red === undefined) {
        console.error(
            "🛑 no RED recorded — run `tdd-gate.ts red` first. GREEN without a witnessed RED proves nothing."
        );
        return 2;
    }

    if (state.red.noRed) {
        console.error("🛑 the recorded red run PASSED (no RED). Re-run `red` until the test actually fails.");
        return 2;
    }

    if (cmd !== state.red.cmd) {
        console.error("🛑 COMMAND MISMATCH — GREEN must run the same command RED witnessed failing.");
        console.error(`    red ran:   ${state.red.cmd}`);
        console.error(`    green ran: ${cmd}`);
        console.error("If the command legitimately changed, re-run `red` with the new command.");
        return 2;
    }

    console.log(`Session: ${session} · red cmd: \`${state.red.cmd}\``);
    console.log(`Guarding: ${state.testFiles.map((entry) => entry.path).join(", ")}`);

    const dir = sessionDir(session);
    const changed = changedTestFiles(state);
    let guard: GreenRecord["guard"] = "clean";

    if (changed.length > 0) {
        if (allowReason === undefined) {
            console.error("🛑 WEAKENED-ASSERTION GUARD TRIPPED");
            console.error("Test file(s) changed between RED and GREEN:");
            for (const file of changed) {
                console.error(`  - ${file}`);
            }

            console.error("GREEN must come from production code changes, not from editing the test.");
            console.error("Recovery:");
            console.error("  1) an assertion changed → re-run `red` so the edited test has its own witnessed failure;");
            console.error("  2) a NON-assertion edit (rename, comment, fixture the test does not assert on) →");
            console.error('     pass --allow-test-edit "<reason>" to record it and proceed.');
            return 3;
        }

        const removed: string[] = [];
        const added: string[] = [];
        for (const file of changed) {
            const entry = state.testFiles.find((candidate) => candidate.path === file);
            if (entry === undefined) {
                continue;
            }

            const snapshot = readFileSync(join(dir, entry.snapshot), "utf8");
            const current = existsSync(file) ? readFileSync(file, "utf8") : "";
            const diff = diffLines(snapshot, current);
            removed.push(...diff.removed);
            added.push(...diff.added);
        }

        const assertionRemoved = removed.filter((line) => ASSERTION_LINE_RE.test(line));
        if (assertionRemoved.length > 0) {
            console.error("🛑 the edit removes or changes an ASSERTION — --allow-test-edit cannot cover that:");
            for (const line of assertionRemoved.slice(0, 5)) {
                console.error(`  - ${line.trim()}`);
            }

            console.error("Re-run `red` so the edited test has its own witnessed failure.");
            return 3;
        }

        const skipAdded = added.filter((line) => SKIP_RE.test(line));
        if (skipAdded.length > 0) {
            console.error("🛑 the edit skips, isolates or stubs out a test — --allow-test-edit cannot cover that:");
            for (const line of skipAdded.slice(0, 5)) {
                console.error(`  - ${line.trim()}`);
            }

            console.error("A skipped test is not a passing test. Re-run `red` with the test active.");
            return 3;
        }

        if (literalFingerprint(removed) !== literalFingerprint(added)) {
            console.error("🛑 the edit changes literal VALUES — a value an assertion consumes changes what the test");
            console.error("expects. --allow-test-edit covers only edits that cannot change whether the test passes");
            console.error("(comments, formatting, imports, identifier renames).");
            console.error("Re-run `red` so the edited test has its own witnessed failure.");
            return 3;
        }

        guard = "edited-allowed";
        state.allowedEdits.push({
            reason: allowReason,
            ts: new Date().toISOString(),
            files: changed,
            removedLines: removed,
            addedLines: added,
        });
        console.log(`⚠️  non-assertion test edit allowed and recorded: "${allowReason}" (${changed.join(", ")})`);
    }

    const run1 = runShell(cmd, join(dir, "green-run1.log"));
    const run2 = runShell(cmd, join(dir, "green-run2.log"));
    const runs: [GreenRunRecord, GreenRunRecord] = [
        { exitCode: run1.exitCode, ts: new Date().toISOString(), logFile: "green-run1.log" },
        { exitCode: run2.exitCode, ts: new Date().toISOString(), logFile: "green-run2.log" },
    ];
    const flaky = (run1.exitCode === 0) !== (run2.exitCode === 0);
    const baseline = new Map((state.snapFiles ?? []).map((snap) => [snap.path, snap.hash]));
    const guardedDirs = new Set(state.testFiles.map((entry) => dirname(entry.path)));
    const guardedNames = new Set(state.testFiles.map((entry) => basename(entry.path)));
    const snapIsGuarded = (snapPath: string): boolean => {
        if (guardedNames.has(basename(snapPath).replace(/\.snap$/, ""))) {
            return true;
        }

        const parent = dirname(snapPath);
        if (basename(parent) === "__snapshots__" && guardedDirs.has(dirname(parent))) {
            return true;
        }

        return guardedDirs.has(parent);
    };
    const snapViolations = scanSnapshotFiles(process.cwd())
        .filter((snap) => snapIsGuarded(snap.path) && baseline.get(snap.path) !== snap.hash)
        .map((snap) => snap.path);
    const redCounts = state.red.counts ?? null;
    const greenCounts = extractTestCounts(run1.output);
    let countViolation: string | null = null;
    if (
        redCounts !== null &&
        greenCounts !== null &&
        (greenCounts.executed < redCounts.executed || greenCounts.skipped > redCounts.skipped)
    ) {
        countViolation =
            `RED executed ${redCounts.executed} test(s), ${redCounts.skipped} skipped; ` +
            `GREEN executed ${greenCounts.executed}, ${greenCounts.skipped} skipped`;
    }

    state.green = { cmd, runs, flaky, guard, snapViolations, countViolation, ts: new Date().toISOString() };
    saveState(state);

    console.log(`Run 1 exit ${run1.exitCode} · run 2 exit ${run2.exitCode}`);

    if (snapViolations.length > 0) {
        console.error("");
        console.error("🛑 SNAPSHOT FILE created or changed between RED and GREEN:");
        for (const file of snapViolations) {
            console.error(`  - ${file}`);
        }

        console.error("A recorded snapshot is not a witnessed assertion — it stores whatever the code produced.");
        console.error("Replace the snapshot assertion with a specific one (see references/test-quality.md),");
        console.error("then re-run `red`.");
        return 3;
    }

    if (countViolation !== null) {
        console.error("");
        console.error("🛑 FEWER TESTS EXECUTED at GREEN than at RED (or new skips):");
        console.error(`  ${countViolation}`);
        console.error("A skipped or removed test is not a passing test. Re-run `red` with the full set active.");
        return 3;
    }

    if (flaky) {
        console.error("");
        console.error("🛑 FLAKY — the two runs DISAGREED. Do NOT declare done.");
        console.error("Find the nondeterminism source: time, randomness, shared state, test-order dependence.");
        console.error("Fix it, then re-run the gate.");
        return 4;
    }

    if (run1.exitCode !== 0) {
        console.log("\nStill RED — the fix does not pass yet. Failure lines from run 1:\n");
        for (const line of extractFailureLines(run1.output)) {
            console.log(`  ${line}`);
        }

        return 1;
    }

    console.log(
        `\n✅ GREEN verified 2/2 · guard: ${guard === "clean" ? "test files unchanged since RED" : "non-assertion edit allowed"}`
    );
    return 0;
}

function cmdReport(explicitSession: string | undefined): number {
    const session = resolveExistingSession(explicitSession);
    const state = session === null ? null : loadState(session);
    if (session === null || state === null || state.red === undefined) {
        console.error("🛑 no session with a recorded RED found — run `tdd-gate.ts red` first.");
        return 2;
    }

    const lines: string[] = [];
    lines.push(`## TDD Gate Evidence — session ${session}`);
    lines.push("");

    const history = state.history ?? [];
    for (const [i, cycle] of history.entries()) {
        const [g1, g2] = cycle.green.runs;
        const guardNote = cycle.green.guard === "clean" ? "guard clean" : "non-assertion edit allowed";
        const headline = cycle.red.failureLines.find((line) => /error/i.test(line)) ?? cycle.red.failureLines[0] ?? "";
        lines.push(
            `**Slice ${i + 1}** — RED exit ${cycle.red.exitCode} (\`${headline.trim()}\`) · ` +
                `GREEN run 1 exit ${g1.exitCode}, run 2 exit ${g2.exitCode} · ${guardNote}`
        );
    }

    if (history.length > 0) {
        lines.push("");
        lines.push(`**Current slice (${history.length + 1}):**`);
    }

    const redLabel = state.red.noRed ? "**RED: NOT WITNESSED — the run PASSED (no-RED branch)**" : "**RED**";
    const redSuffix = state.red.errorNotAssertion === true ? " ⚠️ load/setup error, not an assertion failure" : "";
    lines.push(`${redLabel} (\`${state.red.cmd}\`, exit ${state.red.exitCode}, ${state.red.ts})${redSuffix}:`);
    lines.push("```");
    lines.push(...state.red.failureLines);
    lines.push("```");

    let complete = false;
    if (state.green === undefined) {
        lines.push("**GREEN:** not yet recorded — run `tdd-gate.ts green`.");
    } else {
        const [run1, run2] = state.green.runs;
        const verdict = state.green.flaky
            ? "FLAKY — runs disagreed"
            : run1.exitCode === 0
              ? "passed 2/2"
              : "still failing";
        complete =
            !state.green.flaky &&
            run1.exitCode === 0 &&
            (state.green.snapViolations ?? []).length === 0 &&
            (state.green.countViolation ?? null) === null;
        lines.push(
            `**GREEN** (\`${state.green.cmd}\`): run 1 exit ${run1.exitCode}, run 2 exit ${run2.exitCode} — ${verdict}`
        );
        if (state.green.guard === "clean") {
            lines.push("**Guard:** test files unchanged since RED");
        } else {
            const lastEdit = state.allowedEdits[state.allowedEdits.length - 1];
            lines.push(`**Guard:** non-assertion edit allowed: "${lastEdit?.reason ?? "?"}"`);
            for (const line of lastEdit?.removedLines ?? []) {
                lines.push(`  - removed: \`${line.trim()}\``);
            }

            for (const line of lastEdit?.addedLines ?? []) {
                lines.push(`  - added: \`${line.trim()}\``);
            }
        }

        for (const file of state.green.snapViolations ?? []) {
            lines.push(`🛑 snapshot file created or changed between RED and GREEN: ${file}`);
        }

        if ((state.green.countViolation ?? null) !== null) {
            lines.push(`🛑 fewer tests executed at GREEN than at RED: ${state.green.countViolation}`);
        }
    }

    const changedNow = changedTestFiles(state);
    if (state.green !== undefined && changedNow.length > 0 && state.green.guard === "clean") {
        complete = false;
        lines.push(
            `⚠️ test files changed AFTER green: ${changedNow.join(", ")} — re-run the gate before trusting this.`
        );
    }

    lines.push(`**Test files:** ${state.testFiles.map((entry) => entry.path).join(", ")}`);
    console.log(lines.join("\n"));
    return complete ? 0 : 1;
}

function cmdClean(explicitSession: string | undefined): number {
    if (explicitSession === undefined) {
        console.error("🛑 clean requires --session <name> — a bare clean could remove another agent's session.");
        if (existsSync(SESSIONS_ROOT)) {
            for (const entry of readdirSync(SESSIONS_ROOT)) {
                if (statSync(join(SESSIONS_ROOT, entry)).isDirectory()) {
                    console.error(`  - ${entry}`);
                }
            }
        }

        return 2;
    }

    const session = sanitizeName(explicitSession);
    const dir = sessionDir(session);
    if (!dir.startsWith(SESSIONS_ROOT + sep)) {
        console.error(`🛑 refusing to remove path outside the sessions root: ${dir}`);
        return 2;
    }

    if (!existsSync(dir)) {
        console.error(`no such session dir: ${dir}`);
        return 0;
    }

    rmSync(dir, { recursive: true, force: true });
    console.log(`removed ${dir}`);
    return 0;
}

function readCliArgs() {
    return parseArgs({
        allowPositionals: true,
        options: {
            cmd: { type: "string" },
            "test-file": { type: "string", multiple: true },
            session: { type: "string" },
            "allow-test-edit": { type: "string" },
        },
    } as const);
}

function main(): number {
    let parsed: ReturnType<typeof readCliArgs>;
    try {
        parsed = readCliArgs();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        usage();
        return 2;
    }

    const [subcommand] = parsed.positionals;
    const cmd = parsed.values.cmd;
    const session = parsed.values.session;
    const testFiles = parsed.values["test-file"] ?? [];

    if (subcommand === "red") {
        if (cmd === undefined || testFiles.length === 0) {
            usage();
            return 2;
        }

        return cmdRed(cmd, testFiles, session);
    }

    if (subcommand === "green") {
        if (cmd === undefined) {
            usage();
            return 2;
        }

        return cmdGreen(cmd, session, parsed.values["allow-test-edit"], testFiles.length > 0);
    }

    if (subcommand === "report") {
        return cmdReport(session);
    }

    if (subcommand === "clean") {
        return cmdClean(session);
    }

    usage();
    return 2;
}

process.exit(main());
