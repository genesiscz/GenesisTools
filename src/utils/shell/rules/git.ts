// git shapes that destroy work or someone else's commits.

import {
    commandTokenIndex,
    commandWord,
    originalSlice,
    RESERVED_PREFIX,
    type ShellScan,
    type Span,
    splitPipeline,
    stripShellNoise,
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

interface GitCall {
    tokens: Span[];
    /** Index of the `git` token. */
    git: number;
    /** Index of the subcommand token (`checkout`, `push`, …). */
    sub: number;
}

interface GitInvocation extends GitCall {
    element: Span;
    /** The statements of the unit the invocation sits in, and the index of its own statement there. */
    unit: Span[];
    statement: number;
    /** Index of the element in its statement's pipeline. */
    pipe: number;
}

// `git <sub>` in one pipeline element, with `git -C dir` / `git --no-pager` global options skipped.
function gitCall(element: Span, command: string): GitCall | null {
    const tokens = tokenize(element);
    const git = commandTokenIndex(tokens, command);

    if (git === -1 || commandWord(tokens[git].text) !== "git") {
        return null;
    }

    let i = git + 1;

    while (i < tokens.length && tokens[i].text.startsWith("-")) {
        i +=
            tokens[i].text === "-C" ||
            tokens[i].text === "-c" ||
            tokens[i].text === "--git-dir" ||
            tokens[i].text === "--work-tree"
                ? 2
                : 1;
    }

    return i < tokens.length ? { tokens, git, sub: i } : null;
}

// Every `git <sub>` in the command.
function gitInvocations(scan: ShellScan): GitInvocation[] {
    const out: GitInvocation[] = [];

    for (const unit of scan.units) {
        for (let statement = 0; statement < unit.length; statement++) {
            if (!unit[statement].text.includes("git")) {
                continue;
            }

            const elements = splitPipeline(unit[statement]);

            for (let pipe = 0; pipe < elements.length; pipe++) {
                const call = gitCall(elements[pipe], scan.command);

                if (call) {
                    out.push({ ...call, element: elements[pipe], unit, statement, pipe });
                }
            }
        }
    }

    return out;
}

function elementEnd(element: Span): number {
    return element.start + element.text.length;
}

// Only reserved words stand in front of `git`: no `VAR=value`, `env`, `sudo` or `xargs` that runs it in another tree
// or on other input.
function bareGit(call: GitCall): boolean {
    return call.tokens.slice(0, call.git).every((t) => RESERVED_PREFIX.has(t.text));
}

// Where a git call reads and writes: the words in front of `git` and git's own `-C`, `--git-dir` and `--work-tree`.
// Two calls with the same place see the same files; "" is the shell's folder.
function gitPlace(scan: ShellScan, call: GitCall): string {
    const lead = call.tokens.findIndex((t) => !RESERVED_PREFIX.has(t.text));
    const git = call.tokens[call.git];
    const options = wordsOf(scan.command.slice(git.start + git.text.length, call.tokens[call.sub].start)).args;
    const place = [scan.command.slice(call.tokens[lead].start, git.start)];

    for (let k = 0; k < options.length; k++) {
        if (options[k] === "-C" || options[k] === "--git-dir" || options[k] === "--work-tree") {
            place.push(options[k], options[++k] ?? "");
        } else if (/^--(git-dir|work-tree)=/.test(options[k])) {
            place.push(options[k]);
        } else if (options[k] === "-c") {
            k++;
        }
    }

    return squash(place.join(" "));
}

function squash(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

const HEREDOC_OPENER = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

// `index` sits in the body of a heredoc with an unquoted delimiter: the outer shell expands a `$(…)` there before the
// command that reads the body runs, so before any `cd` in the body.
function inExpandedHeredoc(command: string, index: number): boolean {
    for (const m of command.slice(0, index).matchAll(HEREDOC_OPENER)) {
        const bodyStart = command.indexOf("\n", m.index) + 1;

        if (m[2] !== "" || command[m.index - 1] === "<" || bodyStart === 0 || bodyStart > index) {
            continue;
        }

        const end = new RegExp(`^${m[1] ? "\\t*" : ""}${m[3]}$`, "m").exec(command.slice(bodyStart));

        if (!end || bodyStart + end.index > index) {
            return true;
        }
    }

    return false;
}

// A gate in front of the checkout reads the tree the checkout writes, and decides whether the checkout runs.
function gateable(scan: ShellScan, inv: GitInvocation): boolean {
    return inv.pipe === 0 && bareGit(inv) && !inExpandedHeredoc(scan.command, inv.element.start);
}

/**
 * The original text from `start` to the end of the invocation, quotes intact. The scanner blanks
 * a quoted span, so `git checkout -- "my file.ts"` has no file TOKEN at all, and a suggestion
 * built from tokens came out empty.
 */
function rawTail(scan: ShellScan, inv: GitInvocation, start: number): string {
    return originalSlice(scan, start, elementEnd(inv.element)).trim();
}

function elementMatch(scan: ShellScan, inv: GitInvocation, suggestion?: string): ShellMatch {
    const start = inv.tokens[0].start;
    const matched = originalSlice(scan, start, elementEnd(inv.element));
    return { matched, index: start, ...(suggestion !== undefined ? { suggestion } : {}) };
}

// The whole command with the matched text replaced: the caller copies the corrected line back as it is.
function corrected(scan: ShellScan, match: ShellMatch, replacement: string): string {
    return scan.command.slice(0, match.index) + replacement + scan.command.slice(match.index + match.matched.length);
}

// Shell words as typed, quotes kept.
const RAW_WORD = /(?:[^\s'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g;
const REDIRECTION = /^(\d*|&)(>>?|>\||>&|<<?<?|<&)(.*)$/;

interface Words {
    args: string[];
    /** The file a `>`, `>>` or `&>` sends stdout to. */
    stdout?: string;
}

// The words of a raw text up to a comment, with each redirection and its target set apart from the arguments.
function wordsOf(text: string): Words {
    const words = text.match(RAW_WORD) ?? [];
    const args: string[] = [];
    let stdout: string | undefined;

    for (let k = 0; k < words.length; k++) {
        // A word that starts with `#` opens a comment to the end of the line.
        if (words[k].startsWith("#")) {
            break;
        }

        const m = REDIRECTION.exec(words[k]);

        if (!m) {
            args.push(words[k]);
            continue;
        }

        const target = m[3] !== "" ? m[3] : words[++k];

        if (["", "1", "&"].includes(m[1]) && [">", ">>", ">|"].includes(m[2])) {
            stdout = target;
        }
    }

    return { args, ...(stdout !== undefined ? { stdout } : {}) };
}

// The words after a token up to the end of its element, in the original text.
function wordsAfter(scan: ShellScan, token: Span, element: Span): Words {
    return wordsOf(originalSlice(scan, token.start + token.text.length, elementEnd(element)));
}

// One spelling per path: `"$f"`, `$f` and `./$f` name the same file.
function samePath(word: string): string {
    return word.replace(/^(["'])(.*)\1$/, "$2").replace(/^\.\/(?=.)/, "");
}

const SUBSTITUTION = /\$\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|[<>]\((?:[^()]|\([^()]*\))*\)|`[^`]*`/g;

// What joins statement `k` to statement `k + 1` of a unit, blanks and substitutions dropped: `&&`, `;`, `||`, or ""
// for a newline.
function joiner(scan: ShellScan, unit: Span[], k: number): string {
    const from = elementEnd(unit[k]);
    const to = unit[k + 1].start;
    let gap = scan.cleaned.slice(from, to);

    // Inside `sh -c '…'` the outer cleaned text is blank, and the body's own separators are in the original.
    if (gap.trim() === "") {
        gap = stripShellNoise(scan.command.slice(from, to));
    }

    return gap.replace(SUBSTITUTION, "").replace(/\s+/g, "");
}

// Statement `to` runs only when every statement from `from` on succeeded.
function andChain(scan: ShellScan, unit: Span[], from: number, to: number): boolean {
    for (let k = from; k < to; k++) {
        if (joiner(scan, unit, k) !== "&&") {
            return false;
        }
    }

    return true;
}

// The quote a corrected command can add at `index`: `'` inside a `bash -c "…"` body, none when bodies of both
// quotes hold it.
function freeQuote(scan: ShellScan, index: number): string | undefined {
    const openers = scan.executableRanges
        .filter((range) => index >= range.start && index < range.end)
        .map((range) => scan.command[range.start - 1]);

    if (!openers.includes('"')) {
        return '"';
    }

    return openers.includes("'") ? undefined : "'";
}

// `--ours`, `--theirs`, `-m`, `--merge` and `--conflict` re-create a conflicted merge from the index stages.
function isConflictFlag(arg: string): boolean {
    return (
        ["--ours", "--theirs", "-2", "-3", "-m", "--merge", "--conflict"].includes(arg) || arg.startsWith("--conflict=")
    );
}

interface Revert {
    inv: GitInvocation;
    /** The path text as typed, quotes and redirections kept, for the corrected command. */
    files: string;
    /** The paths alone, to compare with saves and to gate on; empty when they cannot be placed. */
    paths: string[];
    /** A checkout's source: "" for the index, "HEAD", or another ref. A restore has none. */
    ref?: string;
    /** The index is overwritten too, so the staged part of the work is lost along with the unstaged part. */
    resetsIndex: boolean;
}

function checkoutRevert(scan: ShellScan, inv: GitInvocation): Revert | null {
    const args = inv.tokens.slice(inv.sub + 1).map((t) => t.text);
    const dash = args.indexOf("--");
    // Where the paths start in the original text. Without `--`, only `.` and `./…`
    // are unambiguous pathspecs (no ref can be spelled that way), and `git checkout .`
    // discards every uncommitted change exactly like `git checkout -- .`.
    const firstPath = dash === -1 ? args.findIndex((a) => !a.startsWith("-")) : -1;

    if (dash === -1 && (firstPath === -1 || !(args[firstPath] === "." || args[firstPath]?.startsWith("./")))) {
        return null;
    }

    const refEnd = dash === -1 ? firstPath : dash;
    const options = args.slice(0, refEnd);
    const refs = options.filter((a, k) => !a.startsWith("-") && options[k - 1] !== "--conflict");

    // With no tree-ish, the conflict flags write the merge back, and the working copy held markers, not work.
    if (refs.length === 0 && options.some(isConflictFlag)) {
        return null;
    }

    const at = inv.tokens[inv.sub + 1 + refEnd];
    const files = rawTail(scan, inv, dash === -1 ? at.start : at.start + at.text.length);
    const ref = refs[0] ?? "";
    return { inv, files, paths: wordsOf(files).args, ref, resetsIndex: ref !== "" };
}

// The letters of a short option cluster, up to `-s`, whose value is the rest of the word: `-SW` is `-S -W`.
function shortLetters(flag: string): string {
    return /^-[^-]/.test(flag) ? flag.slice(1).split("s")[0] : "";
}

function restoreRevert(scan: ShellScan, inv: GitInvocation): Revert | null {
    const args = inv.tokens.slice(inv.sub + 1).map((t) => t.text);
    const flags = args.filter((a) => a.startsWith("-"));
    const has = (long: string, letter: string) => flags.some((f) => f === long || shortLetters(f).includes(letter));
    const staged = has("--staged", "S");

    if ((staged && !has("--worktree", "W")) || flags.some((f) => isConflictFlag(f) || f === "-h" || f === "--help")) {
        return null;
    }

    // `--source HEAD~1` / `-s HEAD~1` take a value, and it is a tree, not a path: the
    // suggestion put it into `git stash push -- …`, which failed on a bad pathspec.
    // Paths come from the original text after `--`, as for checkout: the scanner blanks
    // a quoted `"my file.ts"`, so a token list dropped it and the suggestion stashed
    // only part of what the user meant to revert. Without `--` a quoted path cannot be
    // placed at all, so there is no suggestion rather than a partial one.
    const dashAt = args.indexOf("--");
    const dashToken = dashAt === -1 ? undefined : inv.tokens[inv.sub + 1 + dashAt];
    const subToken = inv.tokens[inv.sub];
    const unquotedPaths = () =>
        /["']/.test(rawTail(scan, inv, subToken.start + subToken.text.length))
            ? ""
            : args.filter((a, k) => !a.startsWith("-") && args[k - 1] !== "--source" && args[k - 1] !== "-s").join(" ");
    const files = dashToken ? rawTail(scan, inv, dashToken.start + dashToken.text.length) : unquotedPaths();
    return { inv, files, paths: wordsOf(files).args, resetsIndex: staged };
}

// `git worktree add … <dir>` as a whole statement: the folder it makes, as the shell's `cd` would name it.
function worktreeAddDir(scan: ShellScan, statement: Span): string | null {
    const elements = splitPipeline(statement);
    const call =
        statement.text.includes("worktree") && elements.length === 1 ? gitCall(elements[0], scan.command) : null;
    const add = call?.tokens[call.sub + 1];

    if (call?.tokens[call.sub].text !== "worktree" || add?.text !== "add") {
        return null;
    }

    const { args } = wordsAfter(scan, add, elements[0]);
    let dir: string | null = null;

    for (let k = 0; k < args.length && dir === null; k++) {
        if (args[k] === "--") {
            dir = args[k + 1] ?? null;
        } else if (args[k] === "-b" || args[k] === "-B" || args[k] === "--reason") {
            k++;
        } else if (!args[k].startsWith("-")) {
            dir = args[k];
        }
    }

    // `git -C /repo worktree add ../w` makes the folder relative to /repo, and `cd ../w` relative to the shell.
    return dir !== null && gitPlace(scan, call) !== "" && !samePath(dir).startsWith("/") ? null : dir;
}

// The folder a `cd`, `pushd` or `popd` statement moves to ("" when it names none), null for any other statement.
function cdTarget(scan: ShellScan, statement: Span): string | null {
    if (!/\b(cd|pushd|popd)\b/.test(statement.text)) {
        return null;
    }

    for (const element of splitPipeline(statement)) {
        const tokens = tokenize(element);
        const cmd = commandTokenIndex(tokens, scan.command);
        const word = cmd === -1 ? "" : commandWord(tokens[cmd].text);

        if (word === "cd" || word === "pushd" || word === "popd") {
            return wordsAfter(scan, tokens[cmd], element).args.find((a) => !a.startsWith("-")) ?? "";
        }
    }

    return null;
}

// `git worktree add … <dir> && … && cd <dir> && … && <revert>`: a new worktree holds no uncommitted work. A `;` in
// the chain lets the revert run in the old folder when the add failed.
function inFreshWorktree(scan: ShellScan, inv: GitInvocation): boolean {
    for (let w = inv.statement - 1; w >= 0; w--) {
        const dir = worktreeAddDir(scan, inv.unit[w]);

        if (dir === null) {
            continue;
        }

        let inside = false;

        for (let c = w + 1; c < inv.statement; c++) {
            const target = cdTarget(scan, inv.unit[c]);

            if (target !== null) {
                inside = samePath(target) === samePath(dir);
            }
        }

        return inside && andChain(scan, inv.unit, w, inv.statement);
    }

    return false;
}

// `test -z "$(git status --porcelain --untracked-files=all -- <paths>)" && `: the status is empty only when no path is
// untracked, modified or staged, so a checkout behind it overwrites nothing that is not committed.
// `--untracked-files=all` overrides a `status.showUntrackedFiles=no` that hides an untracked file from the status.
function cleanGate(gitPart: string, paths: string[]): string {
    return `test -z "$(${gitPart}status --porcelain --untracked-files=all -- ${paths.join(" ")})" && `;
}

// The statement right before the checkout is that gate on the same paths, and only `&&` lets the checkout run.
function behindCleanGate(scan: ShellScan, inv: GitInvocation, gitPart: string, paths: string[]): boolean {
    const { unit, statement } = inv;

    if (!gateable(scan, inv) || statement === 0 || joiner(scan, unit, statement - 1) !== "&&") {
        return false;
    }

    // `a || <gate> && <checkout>` skips the gate, not the checkout, when `a` succeeds.
    if (statement >= 2 && joiner(scan, unit, statement - 2) === "||") {
        return false;
    }

    const text = scan.command
        .slice(unit[statement - 1].start, inv.element.start)
        .replace(/\\\n/g, " ")
        .replace(/^(?:(?:if|then|elif|else|do|while|until)\s+)*/, "");
    return squash(text) === squash(cleanGate(gitPart, paths));
}

// `git checkout HEAD -- <paths>` after a checkout of the same paths from another ref only takes back that swap,
// provided it runs only when the swap ran (behind a `;`, a failed gate skips the swap and the revert still runs) and
// in the same tree.
function undoesOwnSwap(scan: ShellScan, inv: GitInvocation, paths: string[]): boolean {
    const place = gitPlace(scan, inv);

    for (let s = inv.statement - 1; s >= 0 && paths.length > 0; s--) {
        if (cdTarget(scan, inv.unit[s]) !== null) {
            return false;
        }

        if (!inv.unit[s].text.includes("checkout")) {
            continue;
        }

        const elements = splitPipeline(inv.unit[s]);

        for (let pipe = 0; pipe < elements.length; pipe++) {
            const call = gitCall(elements[pipe], scan.command);

            if (call?.tokens[call.sub].text !== "checkout") {
                continue;
            }

            const swap = checkoutRevert(scan, { ...call, element: elements[pipe], unit: inv.unit, statement: s, pipe });

            if (!swap?.ref || swap.ref === "HEAD" || gitPlace(scan, call) !== place) {
                continue;
            }

            const swapped = new Set(swap.paths.map(samePath));

            if (paths.every((path) => swapped.has(samePath(path)))) {
                return andChain(scan, inv.unit, s, inv.statement);
            }
        }
    }

    return false;
}

// `git stash push` options that save only part of the work.
const PARTIAL_STASH = new Set(["-S", "--staged", "-p", "--patch"]);
// `git diff` options that still print the whole patch.
const PATCH_FLAGS = new Set([
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--full-index",
    "-p",
    "--patch",
    "-a",
    "--text",
]);

function stashedPaths(args: string[]): string[] {
    const paths: string[] = [];

    for (let k = 0; k < args.length; k++) {
        const arg = args[k];

        if (arg === "--") {
            return [...paths, ...args.slice(k + 1)];
        }

        if (PARTIAL_STASH.has(arg) || arg.startsWith("--pathspec-from-file")) {
            return [];
        }

        if (arg === "-m" || arg === "--message") {
            k++;
        } else if (!arg.startsWith("-")) {
            paths.push(arg);
        }
    }

    return paths;
}

interface Diffed {
    paths: string[];
    /** `git diff HEAD`: the patch holds the staged part too, not only what differs from the index. */
    head: boolean;
}

function diffedPaths(args: string[]): Diffed {
    const none: Diffed = { paths: [], head: false };
    const dash = args.indexOf("--");
    const before = dash === -1 ? args : args.slice(0, dash);

    if (before.some((a) => a.startsWith("-") && !PATCH_FLAGS.has(a))) {
        return none;
    }

    const positional = before.filter((a) => !a.startsWith("-"));
    const head = positional[0] === "HEAD";

    if (dash === -1) {
        return { paths: head ? positional.slice(1) : positional, head };
    }

    // Before `--` only HEAD may stand: `git diff main -- a.ts` is not the work on a.ts.
    return positional.length === (head ? 1 : 0) ? { paths: args.slice(dash + 1), head } : none;
}

interface Saves {
    /** Paths a `cp` or a `git diff > <file>` holds. */
    kept: string[];
    /** Paths a `git stash push` holds, until a pop, drop or clear takes the entry off the list. */
    stashed: string[];
}

// The paths a statement saves whole for this revert: `cp <path>… <copy>`, `git stash push … [--] <path>…` and
// `git diff [HEAD] [--] <path>… > <file>`, run in the revert's place.
function savedPaths(scan: ShellScan, statement: Span, revert: Revert, place: string): Saves {
    const kept: string[] = [];
    const stashed: string[] = [];

    for (const element of splitPipeline(statement)) {
        const tokens = tokenize(element);
        const cmd = commandTokenIndex(tokens, scan.command);

        if (cmd === -1) {
            continue;
        }

        // A copy names a file in the shell's folder, which a revert with its own -C or GIT_WORK_TREE does not touch.
        if (commandWord(tokens[cmd].text) === "cp") {
            const args = wordsAfter(scan, tokens[cmd], element).args;
            const end = args.indexOf("--");
            const operands = end === -1 ? args.filter((a) => !a.startsWith("-")) : args.slice(end + 1);

            if (place === "" && operands.length > 1 && samePath(operands[operands.length - 1]) !== "/dev/null") {
                kept.push(...operands.slice(0, -1));
            }

            continue;
        }

        const call = gitCall(element, scan.command);

        if (!call || gitPlace(scan, call) !== place) {
            continue;
        }

        const sub = call.tokens[call.sub];

        if (sub.text === "stash" && call.tokens[call.sub + 1]?.text === "push") {
            stashed.push(...stashedPaths(wordsAfter(scan, call.tokens[call.sub + 1], element).args));
        } else if (sub.text === "diff") {
            const { args, stdout } = wordsAfter(scan, sub, element);
            const diffed = diffedPaths(args);

            // A plain `git diff` holds what differs from the index, and a revert from a ref drops the staged part too.
            if (stdout !== undefined && samePath(stdout) !== "/dev/null" && (diffed.head || !revert.resetsIndex)) {
                kept.push(...diffed.paths);
            }
        }
    }

    return { kept: kept.map(samePath), stashed: stashed.map(samePath) };
}

// `git stash pop`, `drop` or `clear` takes entries off the stash list.
function takesStash(statement: Span, command: string): boolean {
    return (
        statement.text.includes("stash") &&
        splitPipeline(statement).some((element) => {
            const call = gitCall(element, command);
            const verb = call?.tokens[call.sub + 1]?.text ?? "";
            return call?.tokens[call.sub].text === "stash" && ["pop", "drop", "clear"].includes(verb);
        })
    );
}

// The first statement of the saves that hold every reverted path, or null when a path was not saved before the
// revert. A `cd` between the save and the revert makes the same name another file, and so can a `cd` in a subshell
// that closed before the revert: the walk stops at its `)`.
function savedFrom(scan: ShellScan, inv: GitInvocation, revert: Revert): number | null {
    const place = gitPlace(scan, inv);
    const unsaved = new Set(revert.paths.map(samePath));
    let from: number | null = null;
    let stashTaken = false;

    for (let s = inv.statement - 1; s >= 0 && unsaved.size > 0; s--) {
        if (cdTarget(scan, inv.unit[s]) !== null || joiner(scan, inv.unit, s).includes(")")) {
            break;
        }

        const saves = savedPaths(scan, inv.unit[s], revert, place);

        for (const path of stashTaken ? saves.kept : [...saves.kept, ...saves.stashed]) {
            if (unsaved.delete(path)) {
                from = s;
            }
        }

        stashTaken ||= takesStash(inv.unit[s], scan.command);
    }

    return revert.paths.length > 0 && unsaved.size === 0 ? from : null;
}

// A later stash command anywhere after the revert, in a `-c` body too, would take or read the entry a stash
// correction makes instead of the one it meant.
const STASH_READER = /\bstash\s+(?:pop|apply|drop|clear|show)\b/;

// What replaces the matched text: the gate in front of a checkout from another ref, else a stash of the same paths
// that keeps git's global options (`git -C <repo>`) and a loop's `do`.
function revertReplacement(scan: ShellScan, revert: Revert, match: ShellMatch, gitPart: string): string | undefined {
    const { inv, files, paths } = revert;
    const quote = freeQuote(scan, match.index);

    if (paths.length === 0 || quote === undefined) {
        return undefined;
    }

    if (revert.ref && revert.ref !== "HEAD") {
        // The gate's own double quotes would end a `bash -c "…"` body, and `! test -z … && git checkout` runs the
        // checkout only when the paths are dirty.
        if (quote !== '"' || !gateable(scan, inv) || inv.tokens.slice(0, inv.git).some((t) => t.text === "!")) {
            return undefined;
        }

        const git = inv.tokens[inv.git].start;
        return (
            scan.command.slice(match.index, git) +
            cleanGate(gitPart, paths) +
            scan.command.slice(git, match.index + match.matched.length)
        );
    }

    if (STASH_READER.test(scan.command.slice(match.index + match.matched.length))) {
        return undefined;
    }

    const sub = inv.tokens[inv.sub];
    const label = sub.text === "restore" ? "before restore" : "before revert";
    return `${scan.command.slice(match.index, sub.start)}stash push -m ${quote}${label}${quote} -- ${files}`;
}

function blockedRevert(scan: ShellScan, revert: Revert, gitPart: string): ShellMatch {
    const match = elementMatch(scan, revert.inv);
    const replacement = revertReplacement(scan, revert, match, gitPart);
    return replacement === undefined ? match : { ...match, suggestion: corrected(scan, match, replacement) };
}

interface RevertVerdict {
    /** Saved earlier in the same unit: a context note, not a block. */
    saved: boolean;
    match: ShellMatch;
}

// Every checkout or restore that overwrites the working copy, in command order: blocked, or saved first.
function revertVerdicts(scan: ShellScan): RevertVerdict[] {
    const out: RevertVerdict[] = [];

    for (const inv of gitInvocations(scan)) {
        const sub = inv.tokens[inv.sub].text;
        const revert =
            sub === "checkout" ? checkoutRevert(scan, inv) : sub === "restore" ? restoreRevert(scan, inv) : null;

        if (!revert || inFreshWorktree(scan, inv)) {
            continue;
        }

        const gitPart = scan.command.slice(inv.tokens[inv.git].start, inv.tokens[inv.sub].start);
        const fromRef = revert.ref !== undefined && revert.ref !== "" && revert.ref !== "HEAD";

        if (revert.ref === "HEAD" && undoesOwnSwap(scan, inv, revert.paths)) {
            continue;
        }

        if (fromRef && revert.paths.length > 0 && behindCleanGate(scan, inv, gitPart, revert.paths)) {
            continue;
        }

        const from = savedFrom(scan, inv, revert);

        if (from === null) {
            out.push({ saved: false, match: blockedRevert(scan, revert, gitPart) });
            continue;
        }

        const index = inv.unit[from].start;
        out.push({ saved: true, match: { matched: originalSlice(scan, index, elementEnd(inv.element)), index } });
    }

    return out;
}

export const gitCheckoutOverwritesFile: ShellRule = {
    id: "git-checkout-overwrites-file",
    kind: "destructive",
    title: "git checkout -- / git restore overwrites uncommitted work with no way back",
    severity: "block",
    why:
        "`git checkout -- <file>`, `git checkout HEAD -- <file>`, `git checkout <branch> -- <file>` and " +
        "`git restore <file>` replace the working-tree copy and discard whatever was there. Nothing records " +
        "the old content, so a fix you just wrote is gone. `git stash push -- <files>` gets the same clean " +
        "tree and keeps the change recoverable. Only `git restore --staged` (index only) is safe. A checkout " +
        'from another ref passes behind `test -z "$(git status --porcelain --untracked-files=all -- <files>)" &&`, which fails on any ' +
        "untracked, modified or staged file; --ours, --theirs, -m, --merge and --conflict re-create a conflict.",
    wrong: "git checkout -- src/utils/ai/grok/models.ts",
    right: 'git stash push -m "models.ts before revert" -- src/utils/ai/grok/models.ts',
    evidence:
        "CLAUDE.md records two offences on 2026-08-27 with the rule on screen, both mutation checks that " +
        "destroyed an uncommitted fix, plus a scrubbed README regressed by `git checkout <branch> -- file`. " +
        "64 pattern hits in 30 days (Claude 60, Grok 1, Codex 3), the Codex ones all `--staged`.",
    detect(scan): ShellMatch | null {
        return revertVerdicts(scan).find((verdict) => !verdict.saved)?.match ?? null;
    },
};

export const gitCheckoutOverwritesSavedFile: ShellRule = {
    id: "git-checkout-overwrites-saved-file",
    kind: "destructive",
    title: "git checkout -- / git restore reverts a file this command saved first, and holds only if the save did",
    severity: "context",
    why:
        "The matched text runs from the save to the revert, so it names the saved copy: the `cp` destination, the " +
        "stash entry or the patch file. The revert discards only what changed after that save. If `&&` joins every " +
        "step from the save to the revert, a failed save stops the revert. If a `;` or a new line sits between them, " +
        "a failed save (a wrong folder, a full disk, nothing to stash) still lets the revert run, and the work is gone.",
    wrong: "cp src/a.ts /tmp/cc/app/a.fixed.ts; git checkout HEAD -- src/a.ts",
    right: 'git stash push -m "a.ts before revert" -- src/a.ts',
    evidence:
        "Audit of the logged firings, 2026-11-01: three blocked reverts (a cp, a stash push plus a git diff to a " +
        "patch, and a git diff to a patch) had saved the path in the same command, so the block's claim that " +
        "nothing records the old content was false; the stash correction then broke a later git stash pop.",
    detect(scan): ShellMatch | null {
        const verdicts = revertVerdicts(scan);
        return verdicts.some((verdict) => !verdict.saved) ? null : (verdicts.find((v) => v.saved)?.match ?? null);
    },
};

export const gitPushForceWithoutLease: ShellRule = {
    id: "git-push-force-without-lease",
    kind: "destructive",
    title: "git push --force without --force-with-lease overwrites commits you never saw",
    severity: "block",
    why:
        "A plain --force replaces the remote branch with yours whatever the remote holds. If anyone (or " +
        "another session, or a merge) pushed since your last fetch, those commits are gone. " +
        "--force-with-lease refuses when the remote moved, which is exactly the case that destroys work.",
    wrong: "git push --force origin feat/x",
    right: 'git push --force-with-lease origin feat/x   # on "stale info": fetch and look, never escalate to --force',
    evidence: "0 plain --force pushes in 30 days against 296 --force-with-lease; the rule exists so it stays 0.",
    detect(scan): ShellMatch | null {
        for (const inv of gitInvocations(scan)) {
            if (inv.tokens[inv.sub].text !== "push") {
                continue;
            }

            const flag = inv.tokens
                .slice(inv.sub + 1)
                .find(
                    (t) =>
                        t.text === "--force" ||
                        t.text === "-f" ||
                        (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(t.text) && !t.text.startsWith("--"))
                );

            if (!flag) {
                continue;
            }

            const replaced =
                flag.text === "--force" || flag.text === "-f"
                    ? "--force-with-lease"
                    : `${flag.text.replace("f", "")} --force-with-lease`;
            const suggestion =
                scan.command.slice(0, flag.start) + replaced + scan.command.slice(flag.start + flag.text.length);

            return elementMatch(scan, inv, suggestion);
        }

        return null;
    },
};

export const gitRules: readonly ShellRule[] = [
    gitCheckoutOverwritesFile,
    gitCheckoutOverwritesSavedFile,
    gitPushForceWithoutLease,
];
