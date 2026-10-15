import {
    appendFileSync,
    closeSync,
    fstatSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { commandTokenIndex, commandWord, scanShell, splitPipeline, tokenize } from "@genesiscz/utils/shell/scan";
import { commandEditsFiles } from "../../changes/log";
import { hookDiag } from "../log";
import { hookDataRoot, touchesPath } from "../paths";
import type { HookPayload } from "../payload";
import { covers, type Mentions, readSessionState } from "./mentions";
import { assertPrivateFile } from "./private-dir";

/**
 * Who changed a file the post phase found. A root is shared: other sessions, other harnesses and
 * the user's editor all write into it while this command runs, and `git status` cannot say who.
 *
 * The order, strongest first:
 *
 *   1. `named`     the current command's text names the file, or a directory strictly inside the
 *                  root that holds it.
 *   2. `mentioned` an EARLIER tool input of this session named the file, its directory, or a
 *                  glob without `**` that matches it (see `Reach` in `mentions.ts`).
 *   3. `ambiguous` another session took it: a row in the touches ledger from a command that
 *                  overlapped this one, or another session has a command still running in the
 *                  same root. Two runners overlapping in one root cannot be told apart, so this
 *                  is "not provably ours", not "provably theirs".
 *   4. `runner`    nothing above, and the command runs a program. A codemod (`bun x.ts`,
 *                  `fable-replace`, a formatter) legitimately changes files it never names, and
 *                  this is how they stay visible.
 *   5. `others`    a read-only command (`git status`, `rg`, `cat`) cannot have written anything.
 *
 * 🛑 Residual risk of step 4: a writer that leaves no trace (the user's editor, a session without
 * these hooks, a background job) that changes a file during a runner command in the same root is
 * still attributed to that command. The ledger only knows about sessions that run these hooks.
 */
export type Attribution = "named" | "mentioned" | "runner" | "others" | "ambiguous";

/** Commands that cannot write a file on their own (a redirect still can; that is checked apart). */
const READ_ONLY = new Set([
    "cat",
    "head",
    "tail",
    "less",
    "wc",
    "ls",
    "rg",
    "grep",
    "egrep",
    "fgrep",
    "fd",
    "echo",
    "printf",
    "pwd",
    "which",
    "type",
    "stat",
    "file",
    "du",
    "df",
    "ps",
    "date",
    "printenv",
    "jq",
    "sort",
    "uniq",
    "cut",
    "tr",
    "diff",
    "cmp",
    "realpath",
    "readlink",
    "basename",
    "dirname",
    "tree",
    "bat",
    "sed",
    "awk",
    "column",
    "nl",
    "lsof",
    "cd",
    "test",
    "[",
]);

const READ_ONLY_GIT = new Set([
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "ls-files",
    "blame",
    "describe",
    "shortlog",
    "reflog",
    "cat-file",
    "grep",
    "merge-base",
    "rev-list",
    "for-each-ref",
    "name-rev",
]);

/** The session, or `session:agent` for a subagent's call, so a subagent's edit is not its parent's. */
export function actorOf(payload: HookPayload): string {
    const agent = payload.raw.agent_id ?? payload.raw.agentId;
    const session = payload.sessionId ?? "";

    return typeof agent === "string" && agent.length > 0 ? `${session}:${agent}` : session;
}

/** git verbs that bring content the command did not write: other commits, a stash, another branch. */
const HISTORY_GIT = new Set(["rebase", "cherry-pick", "merge", "pull", "am", "revert", "switch", "checkout", "reset"]);

/**
 * The git verb that rewrote the work tree with content the command did not write, or `null`:
 * `rebase`, `cherry-pick`, `stash pop`. Read from the command word of each pipeline element, so a
 * heredoc body that merely mentions `git rebase` does not count.
 *
 * A stopped rebase or cherry-pick leaves the half-applied commit in the work tree, and `stash pop`
 * restores earlier edits; both read as the command's own edits without this (2026-10-14: 7 stopped
 * rebases printed 72 files, 2 stash pops 17).
 */
export function gitOperation(command: string): string | null {
    let units: ReturnType<typeof scanShell>["units"];

    try {
        units = scanShell(command).units;
    } catch (err) {
        hookDiag("Could not scan the command for a git operation", { err });
        return null;
    }

    for (const unit of units) {
        for (const statement of unit) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const index = commandTokenIndex(tokens);
                const word = index === -1 ? undefined : tokens[index];

                if (!word || commandWord(word.text) !== "git") {
                    continue;
                }

                const rest = tokens.slice(index + 1).map((token) => token.text);
                let at = 0;

                while (at < rest.length && rest[at]?.startsWith("-")) {
                    at += rest[at] === "-C" || rest[at] === "-c" ? 2 : 1;
                }

                const verb = rest[at];
                const sub = rest[at + 1];

                if (verb === "stash" && (sub === "pop" || sub === "apply")) {
                    return `stash ${sub}`;
                }

                if (verb && HISTORY_GIT.has(verb)) {
                    return verb;
                }
            }
        }
    }

    return null;
}

/**
 * Whether every stage of the command only reads. Judged by the command word of each pipeline
 * element through the shell scanner, so a quoted `rm` in an `echo` stays read-only, and anything
 * the scanner cannot read, or any redirect, in-place edit or file-writing verb, is a runner.
 */
export function readOnlyCommand(command: string): boolean {
    if (command.trim().length === 0 || commandEditsFiles(command)) {
        return false;
    }

    let units: ReturnType<typeof scanShell>["units"];

    try {
        units = scanShell(command).units;
    } catch (err) {
        hookDiag("Could not scan the command to classify it", { err });
        return false;
    }

    for (const unit of units) {
        for (const statement of unit) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const index = commandTokenIndex(tokens);
                const word = index === -1 ? undefined : tokens[index];

                if (!word) {
                    continue;
                }

                const name = commandWord(word.text);

                if (name === "find" && /\s-(?:delete|exec|execdir|ok|fprint)\b/.test(element.text)) {
                    return false;
                }

                // The element text masks quoted spans, so the check reads the original command, where an awk or sed program survives.
                const raw = ` ${command.slice(element.start, element.start + element.text.length)}`;

                if (READ_ONLY.has(name) && writesThroughItsOwnFlags(name, raw)) {
                    return false;
                }

                if (name === "find" || READ_ONLY.has(name)) {
                    continue;
                }

                if (name !== "git") {
                    return false;
                }

                // `git -C <dir> status`: the verb is the first word that is not an option or
                // the option's value.
                const rest = tokens.slice(index + 1).map((token) => token.text);
                let at = 0;

                while (at < rest.length && rest[at]?.startsWith("-")) {
                    at += rest[at] === "-C" || rest[at] === "-c" ? 2 : 1;
                }

                const verb = rest[at];

                if (verb === undefined || !READ_ONLY_GIT.has(verb)) {
                    return false;
                }
            }
        }
    }

    return true;
}

/**
 * The reading commands that can still write a file their own way: `sort -o`, `tree -o`, awk's `print >`,
 * pipes and `system()`, sed's `w` command. Conservative: a false match only makes the command a runner.
 */
function writesThroughItsOwnFlags(name: string, text: string): boolean {
    switch (name) {
        case "sort":
            return /\s(?:-[a-zA-Z]*o|--output)\b/.test(text);
        case "tree":
            return /\s-o\s/.test(text);
        case "awk":
            return /system\s*\(|>|\|/.test(text);
        case "sed":
            return /(?:^|[\s;{'"/])[wW]\s+\S/.test(text);
        default:
            return false;
    }
}

export interface Touch {
    session: string;
    start: number;
    end: number;
    kind: Attribution;
    path: string;
}

/** Past this the ledger rotates to `.1`; the tail read below never needs more than a few minutes. */
const LEDGER_MAX_BYTES = 2 * 1024 * 1024;
/** The window of rows a post phase reads. A command that runs longer than this is rare. */
const LEDGER_TAIL_BYTES = 512 * 1024;

/**
 * Records which files a session took, so a session whose command overlapped does not take them
 * too. One `appendFileSync` per call: a line is far below PIPE_BUF, so concurrent writers never
 * interleave within a line. Never throws.
 */
export function recordTouches(rows: Touch[], path = touchesPath()): void {
    if (rows.length === 0) {
        return;
    }

    const lines = rows.map((row) => `${row.end}\t${row.start}\t${row.session}\t${row.kind}\t${row.path}\n`).join("");

    try {
        // A shared temp tree: another user's planted folder or a linked ledger is refused, never followed.
        assertPrivateFile(path);

        try {
            if (statSync(path).size > LEDGER_MAX_BYTES) {
                // Two writers may both rotate; the second rename moves a nearly empty file over
                // `.1`, which loses at most a few seconds of rows. Nothing reads that far back.
                renameSync(path, `${path}.1`);
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
                hookDiag("Could not size the touches ledger", { err, path });
            }
        }

        assertPrivateFile(path);
        appendFileSync(path, lines, { mode: 0o600 });
    } catch (err) {
        hookDiag("Could not append to the touches ledger", { err, path });
    }
}

/** Rows from sessions other than `session` whose command ended at or after `since`. */
export function othersTouches({
    session,
    since,
    path = touchesPath(),
}: {
    session: string;
    since: number;
    path?: string;
}): Map<string, Touch[]> {
    const found = new Map<string, Touch[]>();
    let fd: number;

    try {
        fd = openSync(path, "r");
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            hookDiag("Could not open the touches ledger", { err, path });
        }

        return found;
    }

    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - LEDGER_TAIL_BYTES);
        const buf = Buffer.allocUnsafe(size - start);
        const read = readSync(fd, buf, 0, buf.length, start);

        for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
            const [end, begun, owner, kind, file] = line.split("\t");
            const endMs = Number(end);

            if (!file || owner === session || !Number.isFinite(endMs) || endMs < since) {
                continue;
            }

            const list = found.get(file) ?? [];

            list.push({
                session: owner ?? "",
                start: Number(begun),
                end: endMs,
                kind: kind as Attribution,
                path: file,
            });
            found.set(file, list);
        }
    } catch (err) {
        hookDiag("Could not read the touches ledger", { err, path });
    } finally {
        closeSync(fd);
    }

    return found;
}

/**
 * A capture older than this is not treated as a command still running. A Bash call that FAILS
 * gets no PostToolUse, so its capture lingers until the collector's six-hour horizon; counting
 * those would make every later change in that root ambiguous.
 */
const IN_FLIGHT_MS = 15 * 60 * 1000;
/** Calls a session starts together land within this of each other. The stamp has whole seconds. */
const SAME_BATCH_MS = 2_000;

/**
 * Roots in which ANOTHER session has a command running right now, read from the capture tree
 * every pre phase writes (`<harness>/<session>/diff/<call>/roots.txt`). Only read when a
 * change is otherwise unattributed, so the ordinary call never lists it.
 */
export function inFlightRoots({
    session,
    now,
    root = hookDataRoot(),
}: {
    session: string;
    now: number;
    root?: string;
}): Set<string> {
    const roots = new Set<string>();
    const list = (dir: string): string[] => {
        try {
            return readdirSync(dir);
        } catch {
            // Sessions without a running command have no `diff` directory: the normal case.
            return [];
        }
    };

    for (const harness of list(root)) {
        for (const other of list(join(root, harness))) {
            if (other === session) {
                continue;
            }

            const calls = list(join(root, harness, other, "diff"));

            if (calls.length === 0) {
                continue;
            }

            // Calls of one session run one after another, apart from a batch started together.
            // So a pre phase this session began well after a capture means that capture's
            // command is over, and a leftover capture is a command that failed.
            const lastPre = readSessionState(other).lastPre ?? 0;

            for (const call of calls) {
                const dir = join(root, harness, other, "diff", call);

                try {
                    const stamp = Number(readFileSync(join(dir, "stamp"), "utf8").trim()) * 1000;

                    if (!Number.isFinite(stamp) || now - stamp > IN_FLIGHT_MS || lastPre > stamp + SAME_BATCH_MS) {
                        continue;
                    }

                    for (const line of readFileSync(join(dir, "roots.txt"), "utf8").split("\n")) {
                        if (line.length > 0) {
                            roots.add(line);
                        }
                    }
                } catch {
                    // A capture that is being written or removed right now; the next call sees it.
                }
            }
        }
    }

    return roots;
}

export interface AttributionContext {
    session: string;
    /** The command's start, in ms. */
    since: number;
    now: number;
    named: Mentions;
    /** Everything below is lazy: a call whose changes the command named never reads any of it. */
    mentions: () => Mentions;
    readOnly: () => boolean;
    others: () => Map<string, Touch[]>;
    busyRoots: () => Set<string>;
    /**
     * Files another call of this session still in flight names (a parallel call, a subagent's call,
     * a background call): theirs, not this call's, even when this session mentioned them earlier.
     */
    siblings: () => Set<string>;
}

export function attribute({
    file,
    root,
    context,
}: {
    file: string;
    root: string;
    context: AttributionContext;
}): Attribution {
    // A command that only reads changed nothing, even a file it names (`cat src/a.ts`): the change is another writer's.
    if (context.readOnly()) {
        return "others";
    }

    if (covers({ mentions: context.named, file, root, reach: "file" })) {
        return "named";
    }

    // Before the mention index, which is per SESSION: a subagent's Edit, or a parallel call, puts the
    // file there too, and the call that happened to finish first used to print it (2026-10-14:
    // `tools grok usage --help` showed a sibling's `agents-bridge.ts +1-1`). A file another actor NAMED
    // during this call (its Edit, its command), or another call in flight names, is that actor's. An
    // "ambiguous" or "runner" touch is no such evidence: that actor did not know either.
    if (
        context.siblings().has(file) ||
        context
            .others()
            .get(file)
            ?.some((touch) => touch.kind === "named")
    ) {
        return "others";
    }

    // A FOLDER the command names covers every file in it, which says less than naming the file: it
    // comes after another actor's record. 2026-10-15 01:15: a gate's `bun test src/`, run in a worktree
    // after `cd $G`, also resolved against the first `cd` and claimed a subagent's `wizard.ts` edit
    // recorded 2 s earlier.
    if (covers({ mentions: context.named, file, root, reach: "deep" })) {
        return "named";
    }

    if (covers({ mentions: context.mentions(), file, root, reach: "file" })) {
        return "mentioned";
    }

    if (context.others().has(file) || context.busyRoots().has(root)) {
        return "ambiguous";
    }

    return "runner";
}

/** `N file(s) changed by others in this root: a.ts, b.ts and 3 more`, relative to their roots. */
export function summaryLine({
    label,
    files,
    shown = 4,
}: {
    label: string;
    files: Array<{ path: string; root: string }>;
    shown?: number;
}): string {
    const names = files.slice(0, shown).map((file) => relative(file.root, file.path) || file.path);
    const more = files.length > shown ? ` and ${files.length - shown} more` : "";

    return `${files.length} ${label}: ${names.join(", ")}${more}`;
}
