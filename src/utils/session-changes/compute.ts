import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { analyzeCommand, type CommandAnalysis, isLockOrManifest, namedBy } from "./command";
import { type PathRuleContext, pathExclusion, rootOf } from "./rules";
import { fileToolVia, isShellTool } from "./transcript";
import type {
    BlobStore,
    ChangeConfidence,
    ChangeVia,
    ExcludedFile,
    ExclusionReason,
    LoggedChange,
    SessionChanges,
    SessionToolCall,
    SessionTranscript,
    TurnChanges,
    TurnFile,
} from "./types";

/** The id git gives these bytes as a blob (`git hash-object`), computed without spawning git. */
export function gitBlobOid(bytes: Buffer): string {
    return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** The repository a directory sits in (the nearest ancestor holding `.git`), or null. */
export function repoRootOf(dir: string): string | null {
    let current = resolve(dir);

    while (true) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }

        const parent = dirname(current);

        if (parent === current) {
            return null;
        }

        current = parent;
    }
}

export interface SessionChangesInput {
    sessionId: string;
    /** The parsed transcript, or null when only the change log is available. */
    transcript: SessionTranscript | null;
    /** Rows of the session's change log, in file order. */
    log?: LoggedChange[];
    /** Extra working directories that count as the session's own. */
    roots?: string[];
    home?: string;
    tempDirs?: string[];
    /** Resolves a directory to its repository root; tests pass a pure one. */
    repoRoot?: (dir: string) => string | null;
    /** Whether a path is a directory now; a named target that is one is never listed as a file. */
    isDirectory?: (path: string) => boolean;
}

function directoryNow(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        // Gone or unreadable: not a directory this check can see.
        return false;
    }
}

/** One detected change before per-path merging. */
interface Touch {
    path: string;
    via: ChangeVia;
    order: number;
    toolUseId: string;
    agentId: string | null;
    command?: string;
    keep: ChangeConfidence | null;
    reason: ExclusionReason | null;
    before?: string | null;
    after?: string | null;
    beforeOid?: string | null;
    afterOid?: string | null;
    skipped?: "binary" | "large";
    created?: boolean;
    /** A change log row or the harness saw this path change. */
    observed: boolean;
}

export interface ComputedSessionChanges extends SessionChanges {
    /** The bytes behind every blob id this result names, for a caller that must store them. */
    blobs: Map<string, Buffer>;
}

const CONFIDENCE_RANK: Record<ChangeConfidence, number> = { low: 0, medium: 1, high: 2, exact: 3 };

/** A log row's timestamp matched to the shell call whose finish is closest to it. */
function matchRows(rows: LoggedChange[], calls: SessionToolCall[]): Map<LoggedChange, SessionToolCall | null> {
    const shells = calls.filter((call) => call.command !== null && call.finishedAt !== null);
    const byTurn = new Map<string, SessionToolCall[]>();

    for (const call of shells) {
        const list = byTurn.get(call.turnId) ?? [];
        list.push(call);
        byTurn.set(call.turnId, list);
    }

    const matched = new Map<LoggedChange, SessionToolCall | null>();
    const byId = new Map(shells.map((call) => [call.id, call]));

    for (const row of rows) {
        // A row that names its call needs no guessing.
        const named = row.toolUseId ? byId.get(row.toolUseId) : undefined;

        if (named) {
            matched.set(row, named);
            continue;
        }

        const ts = Date.parse(row.ts);
        const pool = byTurn.get(row.turn) ?? [];
        let best: SessionToolCall | null = null;
        let bestGap = Number.POSITIVE_INFINITY;

        for (const call of pool) {
            // The hook writes after the command returns, so a row never predates its call's start.
            if (call.startedAt !== null && ts < call.startedAt - 1_000) {
                continue;
            }

            const gap = Math.abs(ts - (call.finishedAt ?? ts));

            if (gap < bestGap) {
                best = call;
                bestGap = gap;
            }
        }

        matched.set(row, best);
    }

    return matched;
}

/**
 * The verdict for a change a capture saw during a command that did not name it. A command that
 * can write unnamed files keeps it; otherwise the command's strongest automatic kind explains it.
 */
function unnamedVerdict(analysis: CommandAnalysis, path: string): ExclusionReason | null {
    const kinds = new Set(analysis.kinds);

    if (kinds.has("git-rewrite")) {
        return "git-rewrite";
    }

    if (analysis.writesUnnamed) {
        return null;
    }

    if (kinds.has("install")) {
        return isLockOrManifest(path) ? null : "build-output";
    }

    if (kinds.has("build")) {
        return "build-output";
    }

    if (kinds.has("test")) {
        return "test-output";
    }

    return "not-written-by-command";
}

interface TurnContext {
    installs: boolean;
}

/**
 * The checkouts directories sit in (the directory itself when it is in none, or is gone), never
 * the home directory or `/` itself: a `cd ~` must not make the whole home directory "worked in".
 */
function workRoots(input: {
    dirs: readonly string[];
    repoRoot: (dir: string) => string | null;
    home: string;
    /** Count a directory in no checkout as a root itself (a `cd` target that is gone now). */
    bareDirs: boolean;
}): string[] {
    const roots: string[] = [];

    for (const dir of input.dirs) {
        const root = input.repoRoot(dir) ?? (input.bareDirs ? resolve(dir) : null);
        const home = input.home;

        if (root === null) {
            continue;
        }

        if (root !== home && root !== "/" && !roots.includes(root)) {
            roots.push(root);
        }
    }

    return roots;
}

function shellTouches(args: {
    call: SessionToolCall;
    rows: LoggedChange[];
    order: (at: number | null) => number;
    rules: PathRuleContext;
    turn: TurnContext;
    logCovers: boolean;
    repoRoot: (dir: string) => string | null;
    isDirectory: (path: string) => boolean;
    analysis: CommandAnalysis;
}): Touch[] {
    const { call, rows, order, rules, turn, logCovers } = args;
    const command = call.command ?? "";
    const analysis = args.analysis;
    const touches: Touch[] = [];
    const seen = new Set<string>();
    // A command that `cd`s into another checkout works there: its changes in that checkout are
    // judged by what the command is, not dropped as outside the session's directories.
    const commandRoots = workRoots({
        dirs: analysis.workDirs,
        repoRoot: args.repoRoot,
        home: rules.home ?? homedir(),
        bareDirs: true,
    });
    const ctx: PathRuleContext = {
        ...rules,
        roots: [...rules.roots, ...commandRoots],
        turnInstalls: turn.installs,
        snapshotsAllowed: analysis.updatesSnapshots,
    };
    const base = { via: "bash" as const, toolUseId: call.id, agentId: call.agentId, command };
    const judge = (path: string, named: boolean, observed: boolean): Pick<Touch, "keep" | "reason"> => {
        const reason = pathExclusion(path, ctx);

        if (reason) {
            return { keep: null, reason };
        }

        if (named) {
            return { keep: observed ? "high" : "low", reason: null };
        }

        // A change in a checkout the command never ran in came from another writer: the command
        // `cd`d into a worktree while something changed the main checkout, say.
        if (rootOf(path, commandRoots) === null) {
            return { keep: null, reason: "not-written-by-command" };
        }

        const verdict = unnamedVerdict(analysis, path);
        return verdict ? { keep: null, reason: verdict } : { keep: "medium", reason: null };
    };

    for (const row of rows) {
        const touch: Touch = {
            ...base,
            path: row.path,
            order: order(call.startedAt),
            beforeOid: row.beforeOid,
            afterOid: row.afterOid,
            skipped: row.skipped,
            observed: true,
            ...judge(row.path, namedBy(analysis, row.path) || analysis.hints.includes(row.path), true),
        };
        touches.push(touch);
        seen.add(row.path);
    }

    for (const detected of call.harnessDetected ?? []) {
        if (seen.has(detected.path)) {
            continue;
        }

        seen.add(detected.path);
        touches.push({
            ...base,
            path: detected.path,
            order: order(call.startedAt),
            created: detected.created,
            observed: true,
            ...judge(detected.path, namedBy(analysis, detected.path) || analysis.hints.includes(detected.path), true),
        });
    }

    // A named target no capture saw: kept only when nothing could have captured it, since a
    // capture that ran and missed it means the command did not change it (`sed -i` with no match).
    // A failed command is no evidence either: fable-replace, for one, writes nothing on a miss.
    if (!logCovers && !call.isError) {
        for (const path of analysis.writes) {
            if (seen.has(path) || args.isDirectory(path)) {
                continue;
            }

            const verdict = judge(path, true, false);

            // A named target that is excluded and was never observed adds noise, not evidence.
            if (verdict.keep) {
                touches.push({ ...base, path, order: order(call.startedAt), observed: false, ...verdict });
            }
        }
    }

    return touches;
}

function fileTouch(call: SessionToolCall, via: "edit" | "write" | "notebook", order: number): Touch {
    const path = call.filePath ?? "";

    return {
        path,
        via,
        order,
        toolUseId: call.id,
        agentId: call.agentId,
        keep: call.isError ? null : "exact",
        reason: call.isError ? "tool-failed" : null,
        before: call.before,
        after: call.after,
        created: call.before === null,
        observed: !call.isError,
    };
}

function oidOf(text: string | null | undefined, blobs: Map<string, Buffer>): string | null | undefined {
    if (text === undefined || text === null) {
        return text;
    }

    const bytes = Buffer.from(text);
    const oid = gitBlobOid(bytes);
    blobs.set(oid, bytes);
    return oid;
}

/** The calls behind a path's touches. A log row from before per-call ids has none to add. */
function callIds(touches: readonly Touch[]): string[] {
    return [...new Set(touches.map((touch) => touch.toolUseId).filter((id) => id.length > 0))];
}

/** Merge a path's touches (in order) into one file: first before-state, last after-state. */
function mergeKept(path: string, touches: Touch[], blobs: Map<string, Buffer>): TurnFile {
    const first = touches[0] as Touch;
    const last = touches.at(-1) as Touch;
    const explicit = touches.find((touch) => touch.via !== "bash");
    let confidence: ChangeConfidence = "low";

    for (const touch of touches) {
        if (touch.keep && CONFIDENCE_RANK[touch.keep] > CONFIDENCE_RANK[confidence]) {
            confidence = touch.keep;
        }
    }

    const beforeOid = first.before !== undefined ? oidOf(first.before, blobs) : first.beforeOid;
    const afterOid = last.after !== undefined ? oidOf(last.after, blobs) : last.afterOid;
    const file: TurnFile = {
        path,
        via: explicit?.via ?? first.via,
        confidence,
        toolUseIds: callIds(touches),
    };

    // Unknown is not "created" or "deleted": a null state renders as a file the turn added or removed.
    if (beforeOid !== undefined) {
        file.beforeOid = beforeOid;
    }

    if (afterOid !== undefined) {
        file.afterOid = afterOid;
    }

    const skipped = touches.find((touch) => touch.skipped)?.skipped;

    if (skipped) {
        file.skipped = skipped;
    } else if (beforeOid === undefined && !first.created) {
        // Nothing recorded what the file held before; an empty before-state would render as "added".
        file.skipped = "no-before-state";
    } else if (afterOid === undefined) {
        file.skipped = "no-after-state";
    }

    const agents = [...new Set(touches.map((touch) => touch.agentId).filter((id): id is string => id !== null))];

    if (agents.length > 0) {
        file.agentIds = agents;
    }

    const shell = touches.find((touch) => touch.command !== undefined);

    if (shell?.command !== undefined) {
        file.command = shell.command;
    }

    return file;
}

function mergeTurn(turn: TurnChanges, touches: Touch[], blobs: Map<string, Buffer>): void {
    const byPath = new Map<string, Touch[]>();

    for (const touch of [...touches].sort((a, b) => a.order - b.order)) {
        const list = byPath.get(touch.path) ?? [];
        list.push(touch);
        byPath.set(touch.path, list);
    }

    for (const [path, list] of byPath) {
        const kept = list.filter((touch) => touch.keep !== null);

        if (kept.length > 0) {
            turn.files.push(mergeKept(path, kept, blobs));
            continue;
        }

        const first = list[0] as Touch;
        const excluded: ExcludedFile = {
            path,
            reason: first.reason ?? "not-written-by-command",
            via: first.via,
            toolUseIds: callIds(list),
        };

        if (first.command !== undefined) {
            excluded.command = first.command;
        }

        turn.excluded.push(excluded);
    }

    turn.files.sort((a, b) => a.path.localeCompare(b.path));
    turn.excluded.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files of several turns as one change: each path's first before-state and last after-state. */
export function mergeTurnFiles(turns: readonly TurnChanges[]): TurnFile[] {
    const byPath = new Map<string, TurnFile>();

    for (const turn of turns) {
        for (const file of turn.files) {
            const existing = byPath.get(file.path);

            if (!existing) {
                byPath.set(file.path, { ...file, toolUseIds: [...file.toolUseIds] });
                continue;
            }

            existing.afterOid = file.afterOid;
            existing.toolUseIds = [...new Set([...existing.toolUseIds, ...file.toolUseIds])];

            if (file.afterOid === undefined && existing.skipped === undefined) {
                existing.skipped = "no-after-state";
            } else if (file.afterOid !== undefined && existing.skipped === "no-after-state") {
                delete existing.skipped;
            }

            if (CONFIDENCE_RANK[file.confidence] > CONFIDENCE_RANK[existing.confidence]) {
                existing.confidence = file.confidence;
            }

            if (existing.via === "bash" && file.via !== "bash") {
                existing.via = file.via;
            }

            if (file.agentIds) {
                existing.agentIds = [...new Set([...(existing.agentIds ?? []), ...file.agentIds])];
            }
        }
    }

    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The last `count` turns that changed at least one file, in prompt order. */
export function lastChangedTurns(changes: SessionChanges, count: number): TurnChanges[] {
    return changes.turns.filter((turn) => turn.files.length > 0).slice(-count);
}

/**
 * Which files each turn of a session changed, and which detected changes were automatic.
 *
 * Evidence, strongest first: a file tool's own call (exact path, before and after text); a
 * shell command's named write targets; the change log's captures and the harness's own
 * detection, attributed to the shell call they happened under. Every capture a command did not
 * name is judged by what the command is: a script keeps it, a checkout, test run, build or
 * read-only command explains it away. Path rules (temp, cache, build output, logs, lockfiles,
 * app bundles, outside the session's directories) apply to every shell-detected change and
 * never to a file tool's.
 */
export function computeSessionChanges(input: SessionChangesInput): ComputedSessionChanges {
    const rows = input.log ?? [];
    const calls = input.transcript?.calls ?? [];
    const findRoot = input.repoRoot ?? repoRootOf;
    const rootCache = new Map<string, string | null>();
    const repoRoot = (dir: string): string | null => {
        if (!rootCache.has(dir)) {
            rootCache.set(dir, findRoot(dir));
        }

        return rootCache.get(dir) ?? null;
    };
    const cwds = [...(input.transcript?.cwds ?? []), ...rows.map((row) => row.cwd), ...(input.roots ?? [])];
    const roots = new Set<string>();

    for (const cwd of cwds) {
        if (!cwd) {
            continue;
        }

        roots.add(resolve(cwd));
        const repo = repoRoot(cwd);

        if (repo) {
            roots.add(repo);
        }
    }

    const home = input.home ?? homedir();
    const edited = calls
        .filter((call) => fileToolVia(call.name) !== null && call.filePath && !call.isError)
        .map((call) => dirname(call.filePath ?? ""));

    // A repository a file tool edited in is one the session works in, like its cwd.
    for (const root of workRoots({ dirs: [...new Set(edited)], repoRoot, home, bareDirs: false })) {
        roots.add(root);
    }

    const rules: PathRuleContext = { roots: [...roots], home, tempDirs: input.tempDirs };
    const turns = new Map<string, TurnChanges>();

    for (const turn of input.transcript?.turns ?? []) {
        turns.set(turn.turnId, { turnId: turn.turnId, index: turn.index, at: turn.at, files: [], excluded: [] });
    }

    for (const row of rows) {
        if (!turns.has(row.turn)) {
            turns.set(row.turn, { turnId: row.turn, index: null, at: row.ts, files: [], excluded: [] });
        }
    }

    const shellRows = rows.filter((row) => row.source === "bash");
    const matched = matchRows(shellRows, calls);
    const rowsByCall = new Map<string, LoggedChange[]>();
    const orphans: LoggedChange[] = [];

    for (const row of shellRows) {
        const call = matched.get(row);

        if (!call) {
            orphans.push(row);
            continue;
        }

        const list = rowsByCall.get(call.id) ?? [];
        list.push(row);
        rowsByCall.set(call.id, list);
    }

    // Commands are read in the order they ran, so a script or spec an earlier call wrote (a
    // heredoc, or a Write) is known when a later call runs it.
    const installsByTurn = new Map<string, boolean>();
    const analyses = new Map<string, CommandAnalysis>();
    const written = new Map<string, string>();
    const chronological = [...calls].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

    for (const call of chronological) {
        if (fileToolVia(call.name) && call.filePath && typeof call.after === "string") {
            written.set(resolve(call.filePath), call.after);
            continue;
        }

        if (!isShellTool(call.name) || call.command === null) {
            continue;
        }

        const analysis = analyzeCommand({
            command: call.command,
            cwd: call.cwd ?? rules.roots[0] ?? "/",
            files: written,
        });
        analyses.set(call.id, analysis);

        if (analysis.installs && !call.isError) {
            installsByTurn.set(call.turnId, true);
        }
    }

    const firstLog = rows.reduce((min, row) => Math.min(min, Date.parse(row.ts)), Number.POSITIVE_INFINITY);
    let counter = 0;
    // Touches sort by when their call started (subagent calls interleave with the main thread's),
    // then by discovery order within one call.
    const order = (at: number | null) => (at ?? 0) * 1000 + (counter++ % 1000);
    const touchesByTurn = new Map<string, Touch[]>();
    const push = (turnId: string, touches: Touch[]) => {
        const list = touchesByTurn.get(turnId) ?? [];
        list.push(...touches);
        touchesByTurn.set(turnId, list);
    };

    for (const call of calls) {
        const via = fileToolVia(call.name);

        if (via && call.filePath) {
            push(call.turnId, [fileTouch(call, via, order(call.startedAt))]);
            continue;
        }

        if (!isShellTool(call.name) || call.command === null) {
            continue;
        }

        push(
            call.turnId,
            shellTouches({
                call,
                rows: rowsByCall.get(call.id) ?? [],
                order,
                rules,
                turn: { installs: installsByTurn.get(call.turnId) === true },
                logCovers: call.startedAt !== null && call.startedAt >= firstLog,
                repoRoot,
                isDirectory: input.isDirectory ?? directoryNow,
                analysis: analyses.get(call.id) ?? analyzeCommand({ command: call.command, cwd: call.cwd ?? "/" }),
            })
        );
    }

    // Rows no transcript call explains (no transcript, or a call it does not show): only the
    // path rules can judge them, so what survives is kept at the lowest confidence. File-tool
    // rows count only without a transcript, which already names every file-tool call exactly.
    const fileRows = input.transcript ? [] : rows.filter((row) => row.source !== "bash");

    for (const row of [...orphans, ...fileRows]) {
        const explicit = row.source !== "bash";
        const reason = explicit
            ? null
            : pathExclusion(row.path, { ...rules, turnInstalls: installsByTurn.get(row.turn) === true });
        push(row.turn, [
            {
                path: row.path,
                via: row.source === "bash" ? "bash" : row.source,
                order: order(Date.parse(row.ts)),
                // The hook names the call (rows since 2026-09-24): `--tool` must find it here too.
                toolUseId: row.toolUseId ?? "",
                agentId: null,
                keep: reason ? null : explicit ? "exact" : "low",
                reason,
                beforeOid: row.beforeOid,
                afterOid: row.afterOid,
                skipped: row.skipped,
                observed: true,
            },
        ]);
    }

    const blobs = new Map<string, Buffer>();

    for (const [turnId, touches] of touchesByTurn) {
        let turn = turns.get(turnId);

        if (!turn) {
            turn = { turnId, index: null, at: null, files: [], excluded: [] };
            turns.set(turnId, turn);
        }

        mergeTurn(turn, touches, blobs);
    }

    const ordered = [...turns.values()];
    return { sessionId: input.sessionId, turns: ordered, files: mergeTurnFiles(ordered), blobs };
}

/** Persist the blobs a set of files names (for a reader that resolves ids in a store). */
export function storeBlobs(files: readonly TurnFile[], blobs: Map<string, Buffer>, store: BlobStore): void {
    const wanted = new Set<string>();

    for (const file of files) {
        for (const oid of [file.beforeOid, file.afterOid]) {
            if (oid && blobs.has(oid)) {
                wanted.add(oid);
            }
        }
    }

    const ids = [...wanted];

    if (ids.length === 0) {
        return;
    }

    const stored = store(ids.map((id) => blobs.get(id) as Buffer));

    stored.forEach((oid, index) => {
        if (oid !== ids[index]) {
            throw new Error(`blob store returned ${oid} for ${ids[index]}`);
        }
    });
}
