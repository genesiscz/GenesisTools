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
import { basename, extname, join, relative, sep } from "node:path";
import { changeLogPath, changeLogPathIn, readChangeLogFile, walkChangeLogs } from "@genesiscz/utils/agents/change-log";
import { cloudReadRisk } from "@genesiscz/utils/fs/cloud-placeholder";
import { SCRIPT_RUNNERS } from "@genesiscz/utils/session-changes/stages";
import {
    commandTokenIndex,
    commandWord,
    rawToken,
    scanShell,
    splitPipeline,
    tokenize,
} from "@genesiscz/utils/shell/scan";
import { commandEditsFiles } from "../../changes/log";
import { hookDiag } from "../log";
import { hookDataRoot, touchesPath } from "../paths";
import type { HookPayload } from "../payload";
import { canonical, covers, loadFileTimes, type Mentions, readSessionState } from "./mentions";
import { assertPrivateFile } from "./private-dir";

/**
 * Who changed a file the post phase found. A root is shared: other sessions, other harnesses and
 * the user's editor all write into it while this command runs, and `git status` cannot say who.
 * So a file is this call's only with PROOF, and every verdict names the rule that gave it (`Rule`);
 * the decision log keeps the rule for the files it printed and for the ones it declined.
 *
 * The order, strongest first:
 *
 *   1. `read-only`     the command cannot write (`git status`, `rg`, `cat`). Not ours.
 *   2. `named`         the command's text names the file. Ours.
 *   3. `other-named`   another actor named the file during this call (the touches ledger, a call of
 *                      this session still in flight). Theirs.
 *      `other-wrote`   another session's change log holds a write of the file inside this call's
 *                      window, and this session has no later proof on it. Theirs.
 *   4. `named-folder`  the command names a folder strictly inside the root that holds the file. Ours.
 *   5. `scripted`      a script the command names holds the file's path. Ours.
 *   6. `foreign-owned` another session wrote the file in the hour before the call, and this session
 *                      has no later proof on it. Theirs.
 *   7. `own-file`      this session wrote the file before (any age), or a file tool of it named the
 *                      file (a Read, an Edit, a Write), or an earlier command named the exact path.
 *                      Never a folder, a glob or a search. Ours.
 *   8. `own-root`      nothing above, and the root is this session's alone: its path holds this
 *                      session's id, or no other session worked in it for an hour. Ours.
 *   9. `unproven`      nothing above. Not shown as a diff; the note names the files.
 *
 * Measured 2026-11-12 on two days of decisions (1,693 printed files) joined with every session's
 * transcript: 115 files were printed in a shared checkout while another session worked there, and
 * the command did not name them. The old order gave them to the call because an earlier mention
 * counted before any other writer was asked, and because any command that runs a program counted
 * as proof with no evidence at all (`timeout 40 docker system df` was shown a patch another
 * session's agent wrote into the same folder). `tools agents hooks diff audit` repeats the join.
 *
 * 🛑 Residual risk: a writer that leaves no trace (the user's editor, a session without these
 * hooks) that changes a file this session has proof on (rules 4, 5, 7), during this call.
 */
export type Attribution = "named" | "mentioned" | "runner" | "others" | "ambiguous";

/** The rule that decided one file. The log stores it; `diff log` and `diff audit` print it. */
export type Rule =
    | "read-only"
    | "named"
    | "other-named"
    | "other-wrote"
    | "named-folder"
    | "scripted"
    | "foreign-owned"
    | "own-file"
    | "own-root"
    | "unproven";

/** `kind` is what the touches ledger and the render pass act on; `rule` is why. */
export interface Verdict {
    kind: Attribution;
    rule: Rule;
}

/** Whether a verdict makes the file this call's. */
export function isOurs(verdict: Verdict): boolean {
    return verdict.kind !== "others" && verdict.kind !== "ambiguous";
}

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
    const session = payload.sessionId ?? "";

    return payload.agentId ? `${session}:${payload.agentId}` : session;
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
                const index = commandTokenIndex(tokens, command);
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
                const index = commandTokenIndex(tokens, command);
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

/** How long before a call another session's write, or its work in a root, still counts against this call. */
export const FOREIGN_WINDOW_MS = 60 * 60 * 1000;

/** Proof from the change logs and the file tools: who worked on which file, and when (epoch ms). */
export interface Writes {
    /** This session's last proof on a file: its last logged write, or its last Read, Edit or Write of it. */
    mine: Map<string, number>;
    /** The last logged write of a file by ANOTHER session, no older than `FOREIGN_WINDOW_MS` before the call. */
    theirs: Map<string, { session: string; at: number }>;
}

/**
 * Reads `Writes` for one call. Other sessions' logs are read only when they were written inside the
 * window (their mtime); this session's log is read whole, because its own write counts at any age.
 * Never throws: a log that cannot be read costs proof, never the command.
 */
export function sessionWrites({
    session,
    since,
    dir,
}: {
    session: string;
    since: number;
    /** The change-log folder; tests pass their own. */
    dir?: string;
}): Writes {
    const mine = loadFileTimes(session);
    const theirs: Writes["theirs"] = new Map();
    const from = since - FOREIGN_WINDOW_MS;
    const own = (path: string, at: number) => {
        if (Number.isFinite(at) && at > (mine.get(path) ?? 0)) {
            mine.set(path, at);
        }
    };

    try {
        // Another session's write counts only inside the window, so its log is read from the end back to `from` and
        // no further: a long-lived session's history is never read on this hot path.
        for (const { sessionId, rows } of walkChangeLogs({ since: from, rowsSince: from, ...(dir ? { dir } : {}) })) {
            if (sessionId === session) {
                continue;
            }

            for (const row of rows) {
                const at = Date.parse(row.ts);
                const path = canonical(row.path);

                if (Number.isFinite(at) && at > (theirs.get(path)?.at ?? 0)) {
                    theirs.set(path, { session: sessionId, at });
                }
            }
        }

        // This session's own writes are proof at any age (rule `own-file`), so its own log alone is read whole.
        if (session.length > 0) {
            for (const row of readChangeLogFile(dir ? changeLogPathIn(dir, session) : changeLogPath(session)).rows) {
                own(canonical(row.path), Date.parse(row.ts));
            }
        }
    } catch (err) {
        hookDiag("Could not read the change logs, so no write counts as proof", { err, session });
    }

    return { mine, theirs };
}

/**
 * Whether `root` is this session's alone for one call: its path holds the session's id (a worktree
 * under the session's own folder), or no other session shows work in it since an hour before the
 * call (a command in flight, a touch, a logged write, a Bash call of a session that works there).
 */
export function rootIsOwn({
    root,
    session,
    since,
    busy,
    touched,
    writes,
    active,
}: {
    root: string;
    session: string;
    since: number;
    busy: Set<string>;
    /** Files OTHER SESSIONS took during the call. A parallel call of this session does not make the root shared. */
    touched: Iterable<string>;
    writes: Writes;
    /** Other sessions that began a Bash call in the window, with the roots they work in. */
    active: Array<{ session: string; roots: string[] }>;
}): boolean {
    if (session.length > 0 && root.includes(session)) {
        return true;
    }

    if (busy.has(root)) {
        return false;
    }

    const floor = root.endsWith(sep) ? root : `${root}${sep}`;

    for (const path of touched) {
        if (path.startsWith(floor)) {
            return false;
        }
    }

    for (const [path, write] of writes.theirs) {
        if (write.at >= since - FOREIGN_WINDOW_MS && path.startsWith(floor)) {
            return false;
        }
    }

    return !active.some((other) => other.session !== session && other.roots.includes(root));
}

/** Extensions of a file a command runs as a program: its text can name the files it writes. */
const SCRIPT_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".mts",
    ".js",
    ".mjs",
    ".cjs",
    ".py",
    ".sh",
    ".zsh",
    ".bash",
    ".rb",
    ".php",
    ".swift",
    ".pl",
]);
const SCRIPT_MAX_BYTES = 256 * 1024;
/** A bare file name shorter than this is too common to be proof (`index.ts`, `README.md`). */
const DISTINCT_NAME_CHARS = 14;

/**
 * Programs that run the script file given as their first operand (`bun gen.ts`, `python3 -u gen.py`): the shared
 * runners `stageOf` classifies, plus the package runners and languages whose scripts attribution follows as well.
 */
const SCRIPT_FILE_RUNNERS = new Set([...SCRIPT_RUNNERS, "bunx", "ts-node", "npx", "uv", "php", "perl", "swift"]);
/** A runner's verb before the script: `bun run gen.ts`, `deno run gen.ts`, `npx tsx gen.ts`, `uv run gen.py`. */
const RUNNER_VERBS = new Set(["run", "exec", "tsx", "ts-node"]);

/**
 * The script operands a command executes: the program word itself (`./scripts/gen.sh`) or the first operand of a
 * runner (`bun scripts/gen.ts`). A file the command only copies, reads or prints (`cp gen.ts /tmp`) is none.
 */
export function executedScripts(command: string): string[] {
    let units: ReturnType<typeof scanShell>["units"];

    try {
        units = scanShell(command).units;
    } catch (err) {
        hookDiag("Could not scan the command for the scripts it runs", { err });
        return [];
    }

    const operands: string[] = [];

    for (const unit of units) {
        for (const statement of unit) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const index = commandTokenIndex(tokens, command);

                if (index === -1) {
                    continue;
                }

                const head = rawToken(command, tokens[index]);

                if (SCRIPT_EXTENSIONS.has(extname(head))) {
                    operands.push(head);
                    continue;
                }

                if (!SCRIPT_FILE_RUNNERS.has(commandWord(head))) {
                    continue;
                }

                for (const token of tokens.slice(index + 1)) {
                    const word = rawToken(command, token);

                    if (word.startsWith("-") || RUNNER_VERBS.has(word)) {
                        continue;
                    }

                    if (SCRIPT_EXTENSIONS.has(extname(word))) {
                        operands.push(word);
                    }

                    break;
                }
            }
        }
    }

    return operands;
}

/** Whether the absolute `path` is the file a typed `operand` names (`./scripts/gen.ts`, `scripts/gen.ts`, absolute). */
function operandIs(operand: string, path: string): boolean {
    if (operand.startsWith("/")) {
        return operand === path;
    }

    const rel = operand.replace(/^(?:\.\/)+/, "");
    return rel.length > 0 && !rel.startsWith("../") ? path.endsWith(`/${rel}`) : path.endsWith(`/${basename(rel)}`);
}

/**
 * The text of every script the command runs among `paths` (what it names), for rule `scripted`. A file the command
 * only names is no proof, and a file whose read could download it from a cloud provider is not read (the rule
 * named capture and change recording follow). Never throws.
 */
export function scriptTexts({
    paths,
    command,
}: {
    paths: Iterable<string>;
    command: string | undefined;
}): Array<{ path: string; text: string }> {
    const operands = command ? executedScripts(command) : [];
    const out: Array<{ path: string; text: string }> = [];

    if (operands.length === 0) {
        return out;
    }

    for (const path of paths) {
        if (!SCRIPT_EXTENSIONS.has(extname(path)) || !operands.some((operand) => operandIs(operand, path))) {
            continue;
        }

        try {
            const stat = statSync(path);

            if (!stat.isFile() || stat.size > SCRIPT_MAX_BYTES) {
                continue;
            }

            const risk = cloudReadRisk(path, stat);

            if (risk) {
                hookDiag("Not reading a script for proof", { path, risk });
                continue;
            }

            out.push({ path, text: readFileSync(path, "utf8") });
        } catch {
            // A named path that is no file (yet): the usual case for an output path.
        }
    }

    return out;
}

/** Whether `text` holds `needle` as a whole path or name, not inside a longer one (`gen.ts.bak`, `my-gen.ts`). */
function spellsWhole(text: string, needle: string, slashBefore: boolean): boolean {
    const before = slashBefore ? /[\w.-]/ : /[\w./-]/;
    const after = /[\w./-]/;

    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        const prev = text[at - 1];
        const next = text[at + needle.length];

        if ((prev === undefined || !before.test(prev)) && (next === undefined || !after.test(next))) {
            return true;
        }
    }

    return false;
}

/** Whether a script the command runs spells `file`: its absolute path, its path in the root, or a distinct name. */
export function scriptNames({
    scripts,
    file,
    root,
}: {
    scripts: Array<{ path: string; text: string }>;
    file: string;
    root: string;
}): boolean {
    const inRoot = relative(root, file);
    const name = basename(file);
    // A path must stand alone; a bare name may end a path (`out/dev-monitor.ts`), but never a longer name.
    const needles = [
        { needle: file, slashBefore: false },
        ...(inRoot.includes("/") ? [{ needle: inRoot, slashBefore: false }] : []),
        ...(name.length >= DISTINCT_NAME_CHARS ? [{ needle: name, slashBefore: true }] : []),
    ];

    return scripts.some(
        (script) =>
            script.path !== file &&
            needles.some(({ needle, slashBefore }) => spellsWhole(script.text, needle, slashBefore))
    );
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
    /** Who wrote which file, from the change logs and this session's file tools. */
    writes: () => Writes;
    /** The scripts the command names, read once. */
    scripts: () => Array<{ path: string; text: string }>;
    /** Whether a root is this session's alone (`rootIsOwn`); asked once per root, not per file. */
    ownRoot: (root: string) => boolean;
}

export function attribute({
    file,
    root,
    context,
}: {
    file: string;
    root: string;
    context: AttributionContext;
}): Verdict {
    // A command that only reads changed nothing, even a file it names (`cat src/a.ts`): the change is another writer's.
    if (context.readOnly()) {
        return { kind: "others", rule: "read-only" };
    }

    if (covers({ mentions: context.named, file, root, reach: "file" })) {
        return { kind: "named", rule: "named" };
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
        return { kind: "others", rule: "other-named" };
    }

    const writes = context.writes();
    const theirs = writes.theirs.get(file);
    const mine = writes.mine.get(file);
    const theirsIsNewer = theirs !== undefined && (mine === undefined || theirs.at > mine);

    // An Edit or a Write of another session leaves no touch, only its change-log row. Inside this
    // call's window it beats a folder the command names: `cd $G && bun test src/` claimed a file
    // another session edited under `src/` while the tests ran.
    if (theirs && theirsIsNewer && theirs.at >= context.since) {
        return { kind: "others", rule: "other-wrote" };
    }

    // A FOLDER the command names covers every file in it, which says less than naming the file: it
    // comes after another actor's record. 2026-10-15 01:15: a gate's `bun test src/`, run in a worktree
    // after `cd $G`, also resolved against the first `cd` and claimed a subagent's `wizard.ts` edit
    // recorded 2 s earlier.
    if (covers({ mentions: context.named, file, root, reach: "deep" })) {
        return { kind: "named", rule: "named-folder" };
    }

    if (scriptNames({ scripts: context.scripts(), file, root })) {
        return { kind: "named", rule: "scripted" };
    }

    // Before this session's own earlier proof: an old Read of the file does not make another
    // session's fresh write this call's (2026-11-11: `swift test --filter …` was shown
    // `dev-monitor.ts`, which this session had read hours before and another session was editing).
    if (theirsIsNewer) {
        return { kind: "others", rule: "foreign-owned" };
    }

    if (mine !== undefined || covers({ mentions: context.mentions(), file, root, reach: "file" })) {
        return { kind: "mentioned", rule: "own-file" };
    }

    // A file another actor took during this call without naming it is nobody's to prove.
    if (!context.others().has(file) && context.ownRoot(root)) {
        return { kind: "runner", rule: "own-root" };
    }

    return { kind: "ambiguous", rule: "unproven" };
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
