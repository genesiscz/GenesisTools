#!/usr/bin/env bun
/**
 * The approval driver for one Codex `--write ask` worker. The daemon already accepts plainly read-only commands; this
 * approves what the brief allows and prints the rest as NEEDS LEAD for the master. One line per decision (a Monitor
 * feed). It reads the worker's entry in the run card:
 *   { "prs": [{ "name": "bs-511-sol", "cwd": "<abs>", "scope": ["src/a.ts", …], "subject": "fix(x): #511 followup - …",
 *               "verify": ["bun scripts/test.ts src/a.test.ts", "bunx tsgo --noEmit", "bunx biome check"] }] }
 * Approved: normalized in-scope file changes, path-limited git add and commit commands matching the brief's
 * subject, exact configured verification commands, and creation of the babysit scratch folder.
 * Configure the full round-summary command as a verify entry when it should be approved. Everything else waits:
 * chaining, redirection, expansion, sandbox escalations (their request shows the reason, not the command), rituals.
 * One exception to the chaining rule: a chain (`;`, `&&`, `||`, `|`) whose every command only reads (`readOnlyChain`):
 * an independent reviewer asked the lead for 4 such chains in its first 2 minutes (2026-10-15, GenesisPlayground #93).
 *
 * Usage: bun .claude/skills/babysit/scripts/approve-codex.ts --run <run.json> --name <codex session>
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { strictShellWords } from "@app/codex/lib/bus-approval";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";

export interface RunEntry {
    name: string;
    cwd: string;
    scope: string[];
    subject: string;
    verify: string[];
}

const inScope = (entry: RunEntry, path: string) => {
    const root = resolve(entry.cwd);
    const target = resolve(root, path);
    const local = relative(root, target);

    if (!local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep) || /[:*?[\]]/.test(path)) {
        return false;
    }

    const scratch = resolve(root, ".claude/work/babysit");
    return entry.scope.some((allowed) => target === resolve(root, allowed)) || target.startsWith(scratch + sep);
};

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"];

/**
 * Unwrap only an exactly parsed invocation of a known system shell. Codex wraps a command that holds a single quote in
 * double quotes with backslash escapes (`/bin/zsh -lc "sed -n '1,9p' a; rg '\\.md' b"`), which the strict parser
 * refuses; that form is unwrapped when nothing in it expands (no unescaped `$` or backquote), so its reads chain
 * through `readOnlyChain` instead of waking the lead (2026-10-15: 4 of 6 reviewer requests in one minute).
 */
export function innerCommand(command: string): string {
    const words = strictShellWords(command);

    if (words?.length === 3 && SHELLS.includes(words[0]) && ["-c", "-lc"].includes(words[1])) {
        return words[2];
    }

    const quoted = /^(\S+) (-c|-lc) "([\s\S]*)"$/.exec(command);

    if (!quoted || !SHELLS.includes(quoted[1])) {
        return command;
    }

    let inner = "";

    for (let index = 0; index < quoted[3].length; index++) {
        const char = quoted[3][index];

        if (char === "\\" && index + 1 < quoted[3].length && '\\"$`'.includes(quoted[3][index + 1])) {
            inner += quoted[3][index + 1];
            index++;
            continue;
        }

        if (char === "$" || char === "`" || char === '"') {
            return command;
        }

        inner += char;
    }

    return inner;
}

/** Each program a reader may run in a chain, with a check of its arguments: it reads, writes nothing, runs no code. */
const READERS: Record<string, (args: string[]) => boolean> = {
    pwd: () => true,
    ls: () => true,
    cat: () => true,
    head: () => true,
    tail: (args) => !args.some((arg) => /^-[a-zA-Z]*[fF]/.test(arg) || arg === "--follow"),
    wc: () => true,
    nl: () => true,
    cut: () => true,
    tr: () => true,
    file: () => true,
    stat: () => true,
    basename: () => true,
    dirname: () => true,
    realpath: () => true,
    echo: () => true,
    printf: () => true,
    true: () => true,
    test: () => true,
    diff: () => true,
    jq: () => true,
    grep: () => true,
    uniq: (args) => args.filter((arg) => !arg.startsWith("-")).length <= 1,
    sort: (args) => !args.some((arg) => arg === "-o" || arg.startsWith("--output") || /^-[a-zA-Z]*o/.test(arg)),
    rg: (args) => !args.some((arg) => arg === "--pre" || arg.startsWith("--pre=")),
    find: (args) =>
        !args.some((arg) =>
            ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg)
        ),
    // Only `sed -n <range>p <files>`: a second script (`-e 'w <file>'`, `-f`, `-i`) could write, and passed before
    // (found by a Sol reviewer of #536 on 2026-10-16, which proved a file written through an approved "read").
    sed: (args) =>
        args[0] === "-n" &&
        args.length >= 2 &&
        /^(\d+|\$)(,(\d+|\$))?p$/.test(args[1]) &&
        args.slice(2).every((arg) => !arg.startsWith("-")),
    git: (args) =>
        [
            "diff",
            "log",
            "show",
            "status",
            "rev-parse",
            "ls-files",
            "ls-tree",
            "blame",
            "merge-base",
            "cat-file",
            "grep",
            "shortlog",
            "describe",
        ].includes(args[0] ?? "") &&
        !args.some(
            (arg) =>
                arg.startsWith("--output") ||
                arg === "--ext-diff" ||
                // `-O<cmd>` attached runs the command as git grep's pager (a #536 reviewer's probe, 2026-10-16).
                arg.startsWith("-O") ||
                arg.startsWith("--open-files-in-pager")
        ),
    gh: (args) =>
        (args[0] === "pr" && ["view", "diff", "checks", "list"].includes(args[1] ?? "")) ||
        (args[0] === "api" && !args.some((arg) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(arg))),
    tools: toolsReader,
    "./tools": toolsReader,
};

/** `tools github review` without its write verbs, and `tools ts skeleton|duplicates|refactors`, which only read. */
function toolsReader(args: string[]): boolean {
    if (args[0] === "ts") {
        return ["skeleton", "duplicates", "refactors"].includes(args[1] ?? "") && !args.includes("--recommend");
    }

    return (
        args[0] === "github" &&
        args[1] === "review" &&
        !args.some((arg) => /^-?-?(respond|resolve|reply|unresolve)$/.test(arg))
    );
}

/**
 * Splits a chain on unquoted `;`, `&&`, `||`, `|` and newlines. Null when it holds anything else that is not a plain
 * word: a redirection, a background `&`, a command substitution or a variable (each can write, or run code).
 */
export function chainSegments(command: string): string[] | null {
    const segments: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;

    for (let index = 0; index < command.length; index++) {
        const char = command[index];

        if (quote) {
            current += char;

            if (char === quote) {
                quote = null;
            }

            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }

        const pair = command.slice(index, index + 2);

        if (pair === "&&" || pair === "||") {
            segments.push(current);
            current = "";
            index++;
            continue;
        }

        if (char === ";" || char === "|" || char === "\n") {
            segments.push(current);
            current = "";
            continue;
        }

        if (char === "&" || char === ">" || char === "<" || char === "`" || char === "$") {
            return null;
        }

        current += char;
    }

    if (quote) {
        return null;
    }

    segments.push(current);
    return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif"]);

/** A chain of commands that only read: each one a known reader with arguments it cannot write or execute with. */
export function readOnlyChain(entry: RunEntry, command: string): boolean {
    const segments = chainSegments(command);

    if (!segments || segments.length === 0) {
        return false;
    }

    return segments.every((segment) => {
        const parsed = strictShellWords(segment);

        if (!parsed || parsed.length === 0) {
            return false;
        }

        // `if test -f X; then cat X; fi` splits into `if test …`, `then cat …` and `fi`: the keywords run nothing
        // themselves, so the reader after each one decides (a Sol reviewer's first command, 2026-10-15).
        if (parsed[0] === "fi") {
            return parsed.length === 1;
        }

        const words = SHELL_KEYWORDS.has(parsed[0]) ? parsed.slice(1) : parsed;

        if (words.length === 0) {
            return false;
        }

        if (words[0] === "cd") {
            return words.length === 2 && (resolve(entry.cwd, words[1]) + sep).startsWith(resolve(entry.cwd) + sep);
        }

        const check = READERS[words[0]];
        return check !== undefined && check(words.slice(1));
    });
}

/**
 * The briefs' own test command, `timeout <seconds> bun scripts/test.ts <test files>`: every file a `.test.ts(x)` path
 * inside the worktree. A reviewer runs it once per area, and each one woke the lead (2026-10-16: 6 of the first 15
 * NEEDS LEAD lines of five Sol reviewers). It runs inside the worker's sandbox like any other approved command.
 */
export function testRunCommand(entry: RunEntry, words: string[]): boolean {
    const rest = words[0] === "timeout" && /^\d+$/.test(words[1] ?? "") ? words.slice(2) : words;

    if (rest[0] !== "bun" || rest[1] !== "scripts/test.ts" || rest.length < 3) {
        return false;
    }

    const root = resolve(entry.cwd);
    return rest.slice(2).every((path) => {
        const local = relative(root, resolve(root, path));
        return /\.test\.tsx?$/.test(path) && !isAbsolute(local) && !local.startsWith("..") && !/[*?[\]]/.test(path);
    });
}

const FABLE_CLI =
    /(^|\/)(plugins\/genesis-tools|genesis-tools\/genesis-tools\/[\d.]+)\/skills\/fable-replace\/scripts\/cli\.ts$/;
const FABLE_ENV = new Set(["GENESIS_TOOLS_HOME", "TMPDIR", "FABLE_REPLACE_HOME"]);

/**
 * The briefs' edit tool: `[ENV=<scratch> …] bun <…>/fable-replace/scripts/cli.ts <<'TAG' … TAG`, approved when every
 * `@@ <file>` it names is in the brief's scope (or the babysit scratch folder) and each environment value is a
 * `/tmp/cc/` scratch path. Every fixer edit woke the lead before (2026-10-16: the #537 and #533 fixers' first edits).
 */
export function fableReplaceCommand(entry: RunEntry, command: string): boolean {
    const match = /^((?:[A-Z_]+=\S+ )*)bun (\S+) <<'([A-Za-z0-9_]+)'\n([\s\S]*)\n\3\s*$/.exec(command);

    if (!match || !FABLE_CLI.test(match[2])) {
        return false;
    }

    const envOk = match[1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((pair) => {
            const [key, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
            return FABLE_ENV.has(key) && /^\/(private\/)?tmp\/cc\//.test(value) && !value.includes("..");
        });
    const targets = match[4]
        .split("\n")
        .filter((line) => line.startsWith("@@"))
        .map((line) => line.slice(2).trim());

    return envOk && targets.length > 0 && targets.every((path) => !/[`$]/.test(path) && inScope(entry, path));
}

/** Whether a command approval is one the brief allows. Pure, so it can be replayed on a past session's requests. */
export function allowedCommand(entry: RunEntry, command: string): boolean {
    if (readOnlyChain(entry, command) || fableReplaceCommand(entry, command)) {
        return true;
    }

    const words = strictShellWords(command);

    if (!words || words.length === 0) {
        return false;
    }

    if (words[0] === "git" && words[1] === "add" && words[2] === "--") {
        return words.length > 3 && words.slice(3).every((path) => inScope(entry, path));
    }

    if (words[0] === "git" && words[1] === "commit" && words[2] === "-m") {
        return (
            words[4] === "--" &&
            words.length > 5 &&
            words[3].startsWith(entry.subject.split(" - ")[0] + " - ") &&
            words.slice(5).every((path) => inScope(entry, path))
        );
    }

    // The babysit scratch folder, relative or as its absolute path (reviewers write the absolute one from the brief).
    if (
        words.length === 3 &&
        words[0] === "mkdir" &&
        words[1] === "-p" &&
        resolve(entry.cwd, words[2]) === resolve(entry.cwd, ".claude/work/babysit")
    ) {
        return true;
    }

    if (testRunCommand(entry, words)) {
        return true;
    }

    return entry.verify.some((verify) => {
        const allowed = strictShellWords(verify);
        return allowed?.length === words.length && allowed.every((word, index) => word === words[index]);
    });
}

interface ApprovalRequest {
    method?: string;
    detail?: string;
    /** Exact paths from the daemon's file-change item. Missing on older daemons: ask the lead. */
    paths?: unknown;
    command?: unknown;
    cwd?: unknown;
}

/** The decision for one pending request: approve, and the label to print. */
export function decide(entry: RunEntry, request: ApprovalRequest): { ok: boolean; label: string } {
    const method = request.method ?? "";
    const detail = String(request.detail ?? "");

    if (method.includes("fileChange")) {
        const paths = request.paths;

        return {
            ok:
                Array.isArray(paths) &&
                paths.length > 0 &&
                paths.every((path) => typeof path === "string" && path.length > 0 && inScope(entry, path)),
            label: detail,
        };
    }

    const isCommand = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
    const command = typeof request.command === "string" ? innerCommand(request.command) : null;
    const sameCwd =
        typeof request.cwd === "string" && isAbsolute(request.cwd) && resolve(request.cwd) === resolve(entry.cwd);

    return { ok: isCommand && sameCwd && command !== null && allowedCommand(entry, command), label: detail };
}

const STATUS_FAILURE_LIMIT = 10;

export async function watchApprovals({
    entry,
    exec = execTool,
    now = Date.now,
    sleep = Bun.sleep,
    timeoutMs = 1_800_000,
    pollMs = 1500,
}: {
    entry: RunEntry;
    exec?: typeof execTool;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<void> {
    const seen = new Set<string>();
    const failures = new Map<string, number>();
    const deadline = now() + timeoutMs;
    // After a worker's turn ended, `codex status` failed with empty stderr on every poll until the deadline (2026-10-14
    // #516 round 4): say what failed, and hand over to the lead instead of printing it every 1.5 s for 30 minutes.
    let statusFailures = 0;
    const options = () => ({ cwd: entry.cwd, timeout: Math.max(1, Math.min(30_000, deadline - now())) });
    while (now() < deadline) {
        const status = await exec(["codex", "status", "--name", entry.name, "--json"], options());
        let meta: { status?: string; pendingApprovals?: Record<string, ApprovalRequest> } | null = null;
        try {
            if (status.success && !status.timedOut) {
                meta = SafeJSON.parse(status.stdout, { strict: true });
                statusFailures = 0;
            } else {
                statusFailures += 1;
                const said = (status.stderr.trim() || status.stdout.trim() || "no output").replace(/\s+/g, " ");
                console.error(
                    `[approver] status failed (exit ${status.exitCode}${status.timedOut ? ", timed out" : ""}): ${said.slice(0, 200)}`
                );
            }
        } catch (error) {
            console.error("[approver] invalid status: " + String(error));
        }

        if (statusFailures >= STATUS_FAILURE_LIMIT) {
            console.error(
                `[approver] NEEDS LEAD: codex status failed ${statusFailures} times in a row for ${entry.name}; stopped`
            );
            return;
        }

        if (meta?.status === "closed") {
            console.log("[approver] session " + entry.name + " closed");
            return;
        }

        for (const [id, request] of Object.entries(meta?.pendingApprovals ?? {})) {
            if (seen.has(id) || (failures.get(id) ?? 0) >= 3 || now() >= deadline) {
                continue;
            }
            const { ok, label } = decide(entry, request);
            const shown = label.replace(/\s+/g, " ").slice(0, 200);
            if (!ok) {
                seen.add(id);
                console.log("[approver] NEEDS LEAD #" + id + " " + shown);
                continue;
            }

            let acknowledged = false;
            try {
                const result = await exec(["codex", "approve", "--name", entry.name, "--request", id], options());
                acknowledged = result.success && !result.timedOut;
                if (!acknowledged) {
                    console.error(
                        "[approver] approval failed #" + id + " (exit " + result.exitCode + "): " + result.stderr
                    );
                }
            } catch (error) {
                console.error("[approver] approval failed #" + id + ": " + String(error));
            }

            if (acknowledged) {
                seen.add(id);
                console.log("[approver] approved #" + id + ": " + shown);
            } else {
                const count = (failures.get(id) ?? 0) + 1;
                failures.set(id, count);
                if (count >= 3) {
                    console.error("[approver] NEEDS LEAD #" + id + ": approval failed 3 times");
                }
            }
        }
        await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    console.error("[approver] watch deadline reached for " + entry.name);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const flag = (name: string) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const runPath = flag("--run");
    const name = flag("--name");

    if (!runPath || !name) {
        console.error("usage: approve-codex.ts --run <run.json> --name <codex session>");
        process.exit(2);
    }

    const card = SafeJSON.parse(readFileSync(runPath, "utf8"), { strict: true }) as { prs: RunEntry[] };
    const entry = card.prs.find((pr) => pr.name === name);

    if (!entry) {
        console.error(`no entry named ${name} in ${runPath}`);
        process.exit(2);
    }

    await watchApprovals({ entry });
}

if (import.meta.main) {
    await main();
}
