import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { currentCaller } from "@genesiscz/utils/agent/runtime";
import { harnessDrivers, harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import { PLAIN_OUTPUT_ENV } from "@genesiscz/utils/cli/executor";
import { env } from "@genesiscz/utils/env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { ToolAnswer } from "@genesiscz/utils/mcp/tool-entry";
import { endDetachedGroup, killProcessGroup } from "@genesiscz/utils/process/killWithEscalation";

const log = logger.child({ component: "genesis-tools-mcp:replace" });

/**
 * The fable-replace CLI of this checkout. The server never imports the engine: one gateway serves every session, the
 * engine prints to stdout, reads `process.argv` and `process.env`, and its verify blocks in a `spawnSync`.
 */
export const FABLE_REPLACE_CLI_PATH = join(
    moduleDir(import.meta),
    "..",
    "..",
    "..",
    "..",
    "plugins",
    "genesis-tools",
    "skills",
    "fable-replace",
    "scripts",
    "cli.ts"
);

/** One minute over the engine's own 15-minute verify backstop, so the engine reports its timeout first. */
const CHILD_DEADLINE_MS = 16 * 60_000;
/** How long the CLI's process group has after SIGTERM before it gets SIGKILL. */
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 60;
const STDOUT_TAIL_LINES = 10;
const CHILD_NAME = "fable-replace CLI";

const DIFF_LEVELS = ["none", "stat", "full"] as const;
const VERIFY_CONTROLS = ["ts"] as const;
const REGEX_FLAGS = /^[dgimsuvy]*$/;
const REPLACE_DOORS = ["edits", "spec", "renameModule"] as const;
const REPLACE_KEYS = [...REPLACE_DOORS, "cwd", "dryRun", "diff", "verify", "verifyControl", "sessionId"];
const FIND_KEYS = ["cwd", "pattern", "regex", "flags", "roots", "exts"];

/** One run of the CLI: its whole argv, where it runs, and the text on its stdin (none: an empty stdin). */
export interface ReplaceChildRequest {
    argv: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    stdin?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface ReplaceChildResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    /** Set when this side ended the child: its deadline passed, or the MCP call was cancelled. */
    stoppedBy?: "deadline" | "cancelled";
}

export type ReplaceSpawner = (request: ReplaceChildRequest) => Promise<ReplaceChildResult>;

/** What a call runs with: the call's abort signal, and the spawner (a test passes a fake one). */
export interface GenesisReplaceDeps {
    signal?: AbortSignal;
    spawn?: ReplaceSpawner;
}

/**
 * Runs the CLI as the leader of its own process group, so a cancel or the deadline also ends the verify command the
 * engine started. SIGTERM first; the whole group gets SIGKILL when it still holds the pipes after the grace time.
 */
export async function spawnCli(request: ReplaceChildRequest): Promise<ReplaceChildResult> {
    request.signal?.throwIfAborted();
    const child = Bun.spawn({
        cmd: request.argv,
        cwd: request.cwd,
        env: request.env,
        stdin: request.stdin === undefined ? "ignore" : new Blob([request.stdin]),
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
    });
    let stoppedBy: ReplaceChildResult["stoppedBy"];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: "deadline" | "cancelled"): void => {
        stoppedBy ??= reason;
        killProcessGroup(child, "SIGTERM", CHILD_NAME);
        // Runs only while the reads below still hold the child's pipes, so the group id is still this child's.
        escalation ??= setTimeout(() => endDetachedGroup(child, { outputOpen: true, what: CHILD_NAME }), KILL_GRACE_MS);
    };
    const onAbort = (): void => stop("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => stop("deadline"), request.timeoutMs);

    try {
        const [stdout, stderr] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { exitCode: child.exitCode, stdout, stderr, ...(stoppedBy ? { stoppedBy } : {}) };
    } finally {
        clearTimeout(deadline);
        clearTimeout(escalation);
        request.signal?.removeEventListener("abort", onAbort);
    }
}

/**
 * The child's environment. The session it files its backups under is the `sessionId` input, else the calling session
 * of this request (the gateway's caller scope), and the harness comes from the caller's runtime agent. Inside a caller
 * scope this process's own harness session variables describe nobody (the gateway), so they are dropped: an inherited
 * one would otherwise name another session. A stdio server has no caller scope, and its variables are its host's.
 */
function childEnv(sessionId: string | undefined): Record<string, string> {
    const caller = currentCaller();
    const variables: Record<string, string | undefined> = { ...env.getProcessEnv(), ...PLAIN_OUTPUT_ENV };
    if (caller) {
        for (const driver of harnessDrivers()) {
            const { sessionEnvKey, rootSessionEnvKey } = driver.parts.host;
            delete variables[sessionEnvKey];
            if (rootSessionEnvKey) {
                delete variables[rootSessionEnvKey];
            }
        }
    }

    const session = sessionId ?? caller?.sessionId ?? undefined;
    const harness = caller ? harnessOfRuntimeAgent(caller.agent) : null;
    if (session) {
        variables.FABLE_REPLACE_SESSION = session;
    }

    if (harness) {
        variables.FABLE_REPLACE_HARNESS = harness;
    }

    const defined: Record<string, string> = {};
    for (const [key, value] of Object.entries(variables)) {
        if (value !== undefined) {
            defined[key] = value;
        }
    }

    return defined;
}

async function runCli(input: {
    tool: string;
    flags: string[];
    cwd: string;
    stdin?: string;
    sessionId?: string;
    deps: GenesisReplaceDeps;
}): Promise<ReplaceChildResult> {
    const argv = [process.execPath, FABLE_REPLACE_CLI_PATH, ...input.flags];
    const spawn = input.deps.spawn ?? spawnCli;
    const result = await spawn({
        argv,
        cwd: input.cwd,
        env: childEnv(input.sessionId),
        stdin: input.stdin,
        timeoutMs: CHILD_DEADLINE_MS,
        signal: input.deps.signal,
    });
    log.debug(
        {
            tool: input.tool,
            flags: input.flags,
            cwd: input.cwd,
            stdinChars: input.stdin?.length ?? 0,
            exitCode: result.exitCode,
            stoppedBy: result.stoppedBy,
        },
        "fable-replace CLI ran"
    );
    return result;
}

function refuseUnknownKeys(tool: string, args: Record<string, unknown>, known: readonly string[]): void {
    const unknown = Object.keys(args).filter((key) => !known.includes(key));
    if (unknown.length > 0) {
        throw new Error(
            `${tool}: unknown argument ${unknown.map((key) => `"${key}"`).join(", ")}; known: ${known.join(", ")}. Nothing was run.`
        );
    }
}

function requireCwd(tool: string, args: Record<string, unknown>): string {
    const cwd = args.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error(`${tool}: cwd is required, the absolute path of the folder the edit paths start from.`);
    }

    if (!isAbsolute(cwd)) {
        throw new Error(`${tool}: cwd must be an absolute path, got "${cwd}". Nothing was run.`);
    }

    if (!existsSync(cwd)) {
        throw new Error(`${tool}: cwd "${cwd}" does not exist on this machine. Nothing was run.`);
    }

    return cwd;
}

function optionalString(tool: string, args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${tool}: ${key} must be a non-empty string. Nothing was run.`);
    }

    return value;
}

function optionalBoolean(tool: string, args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`${tool}: ${key} must be true or false. Nothing was run.`);
    }

    return value;
}

function optionalChoice<T extends string>(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    choices: readonly T[]
): T | undefined {
    const value = args[key];
    if (value === undefined) {
        return undefined;
    }

    const choice = choices.find((candidate) => candidate === value);
    if (choice === undefined) {
        throw new Error(`${tool}: ${key} must be one of ${choices.join(", ")}. Nothing was run.`);
    }

    return choice;
}

/** A list the CLI takes comma-joined (`--roots a,b`), so an item may not hold a comma. */
function optionalList(tool: string, args: Record<string, unknown>, key: string): string[] | undefined {
    const value = args[key];
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${tool}: ${key} must be a non-empty array of strings. Nothing was run.`);
    }

    return value.map((item) => {
        if (typeof item !== "string" || item.length === 0 || item.includes(",")) {
            throw new Error(`${tool}: every ${key} item must be a non-empty string without a comma. Nothing was run.`);
        }

        return item;
    });
}

/** The door flag and the stdin payload of the one door the call names. */
function replaceDoor(args: Record<string, unknown>): { flags: string[]; stdin: string } {
    const given = REPLACE_DOORS.filter((door) => args[door] !== undefined);
    if (given.length !== 1) {
        const got = given.length > 0 ? ` (got ${given.join(" and ")})` : "";
        throw new Error(`genesis_replace: pass exactly one of edits, spec or renameModule${got}. Nothing was run.`);
    }

    if (args.edits !== undefined) {
        if (!Array.isArray(args.edits) || args.edits.length === 0) {
            throw new Error("genesis_replace: edits must be a non-empty array of FileEdit objects. Nothing was run.");
        }

        return { flags: ["--edits", "-"], stdin: SafeJSON.stringify(args.edits) };
    }

    if (args.renameModule !== undefined) {
        if (!isJsonObject(args.renameModule)) {
            throw new Error(
                "genesis_replace: renameModule must be an object { file, symbol, to, roots }. Nothing was run."
            );
        }

        return { flags: ["--rename-module", "-"], stdin: SafeJSON.stringify(args.renameModule) };
    }

    if (typeof args.spec !== "string" || args.spec.trim().length === 0) {
        throw new Error("genesis_replace: spec must be the FRSPEC text of the run. Nothing was run.");
    }

    return { flags: [], stdin: args.spec };
}

/** The last `max` lines of a child's output, with one marker line that counts the lines cut before them. */
function tail(text: string, max: number, what: string): string[] {
    const trimmed = text.trimEnd();
    if (trimmed.length === 0) {
        return [];
    }

    const lines = trimmed.split("\n");
    if (lines.length <= max) {
        return lines;
    }

    const kept = lines.slice(-(max - 1));
    return [`… ${lines.length - kept.length} earlier ${what} line(s) cut`, ...kept];
}

/**
 * The child's JSON object (`v: 1`), or undefined when its stdout holds none. Under --json the CLI prints that object
 * and nothing else; its last line is tried too, so a stray line printed before it cannot hide the report.
 */
function childReport(stdout: string): Record<string, unknown> | undefined {
    const text = stdout.trim();
    if (text.length === 0) {
        return undefined;
    }

    for (const candidate of new Set([text, text.slice(text.lastIndexOf("\n") + 1)])) {
        try {
            const value: unknown = SafeJSON.parse(candidate, { strict: true });
            if (isJsonObject(value) && value.v === 1) {
                return value;
            }
        } catch (error) {
            log.debug({ error }, "the fable-replace CLI's stdout is not one JSON object");
        }
    }

    return undefined;
}

function howItEnded(result: ReplaceChildResult): string {
    if (result.stoppedBy === "deadline") {
        return `was stopped after ${CHILD_DEADLINE_MS / 60_000} minutes`;
    }

    if (result.stoppedBy === "cancelled") {
        return "was stopped because the call was cancelled";
    }

    return result.exitCode === null ? "was ended by a signal" : `exited ${result.exitCode}`;
}

/** A child that gave no report: its exit, the end of its stdout and its stderr tail, as a failure report. */
function childFailure(tool: string, result: ReplaceChildResult): ToolAnswer {
    log.warn({ tool, exitCode: result.exitCode, stoppedBy: result.stoppedBy }, "the fable-replace CLI gave no report");
    const error = `the fable-replace CLI ${howItEnded(result)} without a JSON report on stdout`;
    const stdout = tail(result.stdout, STDOUT_TAIL_LINES, "stdout");
    const stderr = tail(result.stderr, STDERR_TAIL_LINES, "stderr");
    const lines = [`${tool}: ${error}.`];
    if (stdout.length > 0) {
        lines.push("", "stdout (end):", ...stdout);
    }

    if (stderr.length > 0) {
        lines.push("", "stderr (end):", ...stderr);
    }

    const stopped = result.stoppedBy ? { stoppedBy: result.stoppedBy } : {};
    return failure({ v: 1, ok: false, exitCode: result.exitCode, ...stopped, error }, lines.join("\n"));
}

function count(value: unknown): number | undefined {
    return Array.isArray(value) ? value.length : undefined;
}

/** One line a reader takes in at a glance; the report itself is the structured content. */
function runSummary(report: Record<string, unknown>): string {
    const parts = [`genesis_replace: ${report.ok === true ? "ok" : "FAILED"}`];
    if (typeof report.exitCode === "number") {
        parts.push(`exit ${report.exitCode}`);
    }

    if (report.dryRun === true) {
        parts.push("dry run");
    }

    const files = count(report.files);
    if (files !== undefined) {
        parts.push(`${files} file(s)`);
    }

    const written = count(report.written);
    if (written !== undefined && report.dryRun !== true) {
        parts.push(`${written} written`);
    }

    if (typeof report.missCount === "number") {
        parts.push(`${report.missCount} MISS`);
    }

    if (isJsonObject(report.verify) && typeof report.verify.status === "string") {
        const control = typeof report.verify.control === "string" ? ` (control ${report.verify.control})` : "";
        parts.push(`verify ${report.verify.status}${control}`);
    }

    if (typeof report.error === "string") {
        parts.push(`error: ${report.error}`);
    }

    return parts.join(", ");
}

/**
 * A failed call: isError, and ONE text block that is the JSON report plus a `summary` sentence, the same object as the
 * structured content. A code-mode REPL throws on isError and puts a JSON body, parsed, into the error's `detail`, so
 * the caller reads exitCode, written and backupDir as data instead of parsing a sentence.
 */
function failure(report: Record<string, unknown>, summary: string): ToolAnswer {
    const body = { ...report, summary };
    return { text: SafeJSON.stringify(body, { strict: true }), structuredContent: body, isError: true };
}

/** A call refused before the CLI ran (an unknown key, a bad value): exit 2, the shape of the CLI's own refusals. */
function usageFailure(error: unknown): ToolAnswer {
    const message = error instanceof Error ? error.message : String(error);
    return failure({ v: 1, ok: false, exitCode: 2, error: message }, message);
}

function objects(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

/** What a person reads of a failed run: the summary line, each MISS with its reason, and after exit 3 the undo. */
function failureSummary(report: Record<string, unknown>, stderr: string[]): string {
    const lines = [runSummary(report)];
    for (const entry of objects(report.files)) {
        for (const op of objects(entry.ops).filter(
            (candidate) => candidate.status === "MISS" || candidate.status === "NOOP"
        )) {
            lines.push(`${String(op.status)} ${String(entry.file)}: ${String(op.desc)}: ${String(op.reason ?? "")}`);
        }

        const failed = Array.isArray(entry.postConditionFailures) ? entry.postConditionFailures : [];
        for (const reason of failed) {
            lines.push(`FAILED ${String(entry.file)}: ${String(reason)}`);
        }
    }

    if (report.exitCode === 3) {
        // written holds plain paths; a person reads a rename as its pair, which files[].renamedTo carries.
        const renamedFrom = new Map(
            objects(report.files)
                .filter((entry) => typeof entry.renamedTo === "string")
                .map((entry) => [String(entry.renamedTo), String(entry.file)])
        );
        const written = (Array.isArray(report.written) ? report.written.map(String) : []).map((file) => {
            const from = renamedFrom.get(file);
            return from === undefined ? file : `${from} → ${file}`;
        });
        lines.push(`The ${written.length} written file(s) keep the sweep: ${written.join(", ")}.`);
        lines.push(
            typeof report.backupDir === "string"
                ? `Undo everything with: bun "${FABLE_REPLACE_CLI_PATH}" --rollback "${report.backupDir}"`
                : "No backup was taken, so there is nothing to roll back."
        );
        lines.push("Fix forward with a new call, or roll back. Never resend the same edits.");
    }

    if (stderr.length > 0) {
        lines.push("", ...stderr);
    }

    return lines.join("\n");
}

/** What one call hands the CLI. */
interface CliCall {
    flags: string[];
    cwd: string;
    stdin?: string;
    sessionId?: string;
}

/** The CLI flags, cwd, stdin and session of one genesis_replace call; throws on an argument it refuses. */
function replaceCall(tool: string, args: Record<string, unknown>): CliCall {
    refuseUnknownKeys(tool, args, REPLACE_KEYS);
    const cwd = requireCwd(tool, args);
    const door = replaceDoor(args);
    const dryRun = optionalBoolean(tool, args, "dryRun") ?? false;
    const diff = optionalChoice(tool, args, "diff", DIFF_LEVELS) ?? "stat";
    const verify = optionalString(tool, args, "verify");
    const verifyControl = optionalChoice(tool, args, "verifyControl", VERIFY_CONTROLS);
    const sessionId = optionalString(tool, args, "sessionId");
    const flags = [
        ...door.flags,
        "--json",
        "--cwd",
        cwd,
        ...(dryRun ? ["--dry"] : []),
        "--diff",
        diff,
        ...(verify ? ["--verify", verify] : []),
        ...(verifyControl ? ["--verify-control", verifyControl] : []),
    ];
    return { flags, cwd, stdin: door.stdin, sessionId };
}

/**
 * `genesis_replace`: one fable-replace run through the CLI's JSON door. A landed run answers the CLI's RunReportJson
 * as the structured content. Every failure (a MISS, a refusal, a red verify, a CLI that gave no report) answers
 * isError with that report as JSON in the one text block, plus a summary sentence.
 */
export async function handleGenesisReplace(
    args: Record<string, unknown>,
    deps: GenesisReplaceDeps = {}
): Promise<ToolAnswer> {
    const tool = "genesis_replace";
    let call: CliCall;
    try {
        call = replaceCall(tool, args);
    } catch (error) {
        return usageFailure(error);
    }

    const result = await runCli({ tool, ...call, deps });
    const report = childReport(result.stdout);
    if (!report || typeof report.ok !== "boolean") {
        return childFailure(tool, result);
    }

    const stderr = tail(result.stderr, STDERR_TAIL_LINES, "stderr");
    if (!report.ok) {
        return failure(report, failureSummary(report, stderr));
    }

    const text = stderr.length > 0 ? [runSummary(report), "", ...stderr].join("\n") : runSummary(report);
    return { text, structuredContent: report, isError: false };
}

/**
 * A literal or `/source/flags` for `--find`. A literal that starts with "/" would read as a regex there, so it goes
 * as an escaped regex that matches exactly the literal.
 */
function findArgument(pattern: string, regex: boolean, flags: string | undefined): string {
    if (regex) {
        return `/${pattern.replace(/(?<!\\)\//g, "\\/")}/${flags ?? ""}`;
    }

    if (pattern.startsWith("/")) {
        return `/${pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`;
    }

    return pattern;
}

/** The CLI flags and cwd of one genesis_replace_find call; throws on an argument it refuses. */
function findCall(tool: string, args: Record<string, unknown>): CliCall {
    refuseUnknownKeys(tool, args, FIND_KEYS);
    const cwd = requireCwd(tool, args);
    const pattern = optionalString(tool, args, "pattern");
    if (pattern === undefined) {
        throw new Error(`${tool}: pattern is required, a literal or (with regex: true) a RegExp source.`);
    }

    const regex = optionalBoolean(tool, args, "regex") ?? false;
    const flags = args.flags === "" ? undefined : optionalString(tool, args, "flags");
    if (flags !== undefined && (!regex || !REGEX_FLAGS.test(flags))) {
        throw new Error(`${tool}: flags needs regex: true and only the letters dgimsuvy. Nothing was run.`);
    }

    const roots = optionalList(tool, args, "roots") ?? ["."];
    const exts = optionalList(tool, args, "exts");
    return {
        flags: [
            "--find",
            findArgument(pattern, regex, flags),
            "--roots",
            roots.join(","),
            ...(exts ? ["--ext", exts.join(",")] : []),
            "--cwd",
            cwd,
            "--json",
        ],
        cwd,
    };
}

/**
 * `genesis_replace_find`: the recon of a pattern under roots, the CLI's ReconReport as the structured content. A
 * failure answers isError with a JSON report in the text, as genesis_replace does.
 */
export async function handleGenesisReplaceFind(
    args: Record<string, unknown>,
    deps: GenesisReplaceDeps = {}
): Promise<ToolAnswer> {
    const tool = "genesis_replace_find";
    let call: CliCall;
    try {
        call = findCall(tool, args);
    } catch (error) {
        return usageFailure(error);
    }

    const result = await runCli({ tool, ...call, deps });
    const report = childReport(result.stdout);
    if (report?.ok === false) {
        return failure(report, `${tool}: FAILED, exit ${String(report.exitCode)}, error: ${String(report.error)}`);
    }

    if (!report || typeof report.total !== "number" || !Array.isArray(report.files)) {
        return childFailure(tool, result);
    }

    return {
        text: `${tool}: ${report.total} match(es) in ${report.files.length} file(s)`,
        structuredContent: report,
    };
}

export const GENESIS_REPLACE_DESCRIPTION =
    "Verified, transactional find/replace across files (fable-replace) as structured data: JSON in, a JSON report " +
    'out. In a code-mode REPL call it as await tools["mcp__genesis-tools__genesis_replace"](input) (the short name ' +
    "does not resolve); a landed run arrives as the report in a JSON string, so JSON.parse it. Pass cwd (absolute) " +
    "and exactly ONE of: edits (an array of FileEdit objects, e.g. " +
    '[{ "file": "src/a.ts", "ops": [{ "find": "oldName", "replace": "newName", "count": "all" }] }]; a regex op is ' +
    '{ "kind": "regex", "find": { "source": "foo([0-9]+)", "flags": "g" }, "replace": "bar$1" }; a whole-file rewrite ' +
    'is { "kind": "rewrite", "content": "…", "expectSha256": "<sha256>" }: dry-run it without expectSha256, then send ' +
    "that report's sha256Before for the file as expectSha256, because a real run without it is refused), spec " +
    "(FRSPEC text, the heredoc format of the fable-replace skill), or renameModule ({ file, symbol, to, roots } " +
    "renames a type or function, its file and every import of it, staged as a git rename). Every op must match " +
    "exactly as declared; the batch is all-or-nothing, with a backup in the session's scratch folder. dryRun: true " +
    'previews and writes nothing. diff: "none" | "stat" | "full", default "stat" on a dry run and a real run alike: ' +
    "full adds each changed file's diff text, and every changed file carries diffStat at any level (a FileEdit's " +
    'own diff wins; renameModule asks full). verify: a command run in cwd after the write; verifyControl: "ts" ' +
    "first plants a type error and runs that command on it, and the report's verify.control says what happened: " +
    "caught (it reported the probe, so the verify verdict counts) or missed (it did not, so the real verify never " +
    "ran and its status is unknown, exit 3); no control key means none was asked or it could not be measured. The " +
    "report: ok, exitCode (0 landed, 1 a MISS and nothing written, 2 refused, 3 written but the verify failed), " +
    "files with sha256Before (the hash of the content the run read), renamedTo on a renamed file and each op's " +
    'status (OK | MISS | SKIP), found, reason, expected (the declared count: a number or "all") and lines (the ' +
    "1-based line of each occurrence it found), expected and lines on OK and MISS alike; a file pre-flight refused " +
    '(exit 2) is { file, action: "refused", reason } with no ops. Then written (plain paths: the new path after a ' +
    "rename), backupDir (only when the run backed a file up, so a run that wrote nothing has none), verify, " +
    "warnings. A failure " +
    "THROWS in the REPL, and e.detail is the report, parsed, with a summary sentence that names the rollback command " +
    "after exit 3; a refusal before the run is { v, ok: false, exitCode: 2, error, summary }. A MISS names the line " +
    "to re-read: fix the op and run again; never resend the same edits after exit 3.";

export const GENESIS_REPLACE_INPUT_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        cwd: {
            type: "string",
            description: "absolute path of the folder the edit paths start from (usually the repository root)",
        },
        edits: {
            type: "array",
            minItems: 1,
            items: { type: "object" },
            description:
                "FileEdit objects: { file, ops?, createWith?, delete?, renameTo?, expectAfter?, absentAfter?, " +
                "absentInChange?, diff? }. A RegExp field is { source, flags }; an unknown key is refused",
        },
        spec: { type: "string", description: "FRSPEC text, the same format the fable-replace CLI reads on stdin" },
        renameModule: {
            type: "object",
            properties: {
                file: { type: "string", description: "the file named after the symbol, e.g. src/Foo.ts" },
                symbol: { type: "string", description: "the symbol to rename, e.g. Foo" },
                to: { type: "string", description: "the new name; the file becomes <dir>/<to><ext>" },
                roots: { type: "array", items: { type: "string" }, description: "folders whose files are rewritten" },
                includeShadowed: { type: "boolean", description: "also rewrite files that declare their own symbol" },
            },
            required: ["file", "symbol", "to", "roots"],
            description: "rename a symbol and its file with every import (each file's diff is full)",
        },
        dryRun: { type: "boolean", description: "preview only: nothing is written, no backup (default false)" },
        diff: {
            type: "string",
            enum: [...DIFF_LEVELS],
            description:
                "how much of each change the report carries: none or stat (diffStat only) or full (the diff text too); " +
                "default stat, on a dry run and a real run alike; a FileEdit's own diff wins",
        },
        verify: {
            type: "string",
            description:
                "a command run in cwd after the write, e.g. tsc-rs --noEmit -p tsconfig.json; red keeps the files",
        },
        verifyControl: {
            type: "string",
            enum: [...VERIFY_CONTROLS],
            description: "ts: before trusting the verify, prove it reports a planted type error in the edited folder",
        },
        sessionId: {
            type: "string",
            description: "the session whose scratch folder holds the backup (default: the calling session)",
        },
    },
    required: ["cwd"],
    additionalProperties: false,
};

export const GENESIS_REPLACE_FIND_DESCRIPTION =
    "Recon before an edit (read-only): where a literal or a regex occurs under roots, as JSON. In a code-mode REPL " +
    'call it as await tools["mcp__genesis-tools__genesis_replace_find"](input) and JSON.parse the result: ' +
    "{ v, pattern, roots, total, files: [{ file, count, declares }] }. count and total count occurrences, not lines; " +
    "declares marks a file that declares an identifier-shaped pattern (its own symbol of that name). A failure " +
    "throws, with the report in e.detail. Use it to size a genesis_replace before you write one.";

export const GENESIS_REPLACE_FIND_INPUT_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        cwd: { type: "string", description: "absolute path the roots start from" },
        pattern: { type: "string", description: "a literal, or with regex: true a RegExp source" },
        regex: { type: "boolean", description: "read pattern as a RegExp source (default false)" },
        flags: { type: "string", description: "RegExp flags with regex: true, e.g. i" },
        roots: { type: "array", items: { type: "string" }, description: 'folders to search (default ["."])' },
        exts: { type: "array", items: { type: "string" }, description: 'file extensions, e.g. [".ts", ".tsx"]' },
    },
    required: ["cwd", "pattern"],
    additionalProperties: false,
};
