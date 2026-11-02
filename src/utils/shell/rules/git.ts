// git shapes that destroy work or someone else's commits.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
    commandTokenIndex,
    commandWord,
    NUMERIC_GLOB,
    originalSlice,
    RESERVED_PREFIX,
    runningShell,
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

// `index` sits in the body of a heredoc with an unquoted delimiter, fed to a shell or not: the outer shell expands a
// `$(…)` there before the command that reads the body runs, so before any `cd` in the body.
function inExpandedHeredoc(scan: ShellScan, index: number): boolean {
    return scan.heredocs.some((heredoc) => !heredoc.quoted && heredoc.start <= index && index < heredoc.end);
}

// A gate in front of the checkout reads the tree the checkout writes, and decides whether the checkout runs.
function gateable(scan: ShellScan, inv: GitInvocation): boolean {
    return inv.pipe === 0 && bareGit(inv) && !inExpandedHeredoc(scan, inv.element.start);
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
// The longer operators first, which would otherwise leave their `&`, `|` or `!` as the target: `>&`, `>|` and zsh's
// `>!`, `>&|` and `>>|`.
const REDIRECTION = /^(\d*|&)(>>&[|!]?|>&[|!]?|>>?[|!]?|<&|<<?<?)(.*)$/;
// Text before a `>` that stays with the operator: a descriptor (`2>`), `&` (`&>`), or the operator so far.
const OPERATOR_SO_FAR = /^(?:\d*|&)[<>&|!]*$/;

// The shells that write every stdout target of `> a > b` (MULTIOS); "" is the zsh the command was typed into.
const MULTIOS_SHELLS: ReadonlySet<string> = new Set(["", "zsh"]);

interface StdoutTarget {
    file: string;
    /** `>>`: stdout is added to the file, not written over it. */
    appends: boolean;
}

interface Words {
    args: string[];
    /** Every file stdout goes to: zsh's MULTIOS writes each of `> a > b`, and bash truncates `a`. */
    stdout: StdoutTarget[];
    /** Every file any output redirection opens, stderr's (`2> err.log`) too. */
    writes: string[];
}

// A word cut where the shell cuts it: before an unquoted `>` that follows text, so `main:a.ts>a.ts` is the object
// and a redirection, and `a>b>c` writes b and c.
function redirectionParts(word: string): string[] {
    const parts: string[] = [];
    let from = 0;

    for (let i = 0; i < word.length; i++) {
        if (word[i] === "\\") {
            i++;
        } else if (word[i] === "'") {
            const close = word.indexOf("'", i + 1);
            i = close === -1 ? word.length : close;
        } else if (word[i] === '"') {
            for (i++; i < word.length && word[i] !== '"'; i++) {
                i += word[i] === "\\" ? 1 : 0;
            }
        } else if (word[i] === "<") {
            i += (NUMERIC_GLOB.exec(word.slice(i))?.[0].length ?? 1) - 1;
        } else if (word[i] === ">" && !OPERATOR_SO_FAR.test(word.slice(from, i))) {
            parts.push(word.slice(from, i));
            from = i;
        }
    }

    parts.push(word.slice(from));
    return parts;
}

// The words of a raw text up to a comment, with each redirection and its target set apart from the arguments.
function wordsOf(text: string): Words {
    const words = (text.match(RAW_WORD) ?? []).flatMap((word) => (word.includes(">") ? redirectionParts(word) : word));
    const args: string[] = [];
    const stdout: StdoutTarget[] = [];
    const writes: string[] = [];

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
        // `>& <file>` writes stdout and stderr to the file; `>&2`, `>& 2` and `>&-` name a descriptor.
        const file = !m[2].endsWith("&") || !/^(\d+|-)$/.test(target ?? "");

        if (m[2].startsWith(">") && file && target !== undefined) {
            writes.push(target);

            if (["", "1", "&"].includes(m[1])) {
                stdout.push({ file: target, appends: m[2].startsWith(">>") });
            }
        }
    }

    return { args, stdout, writes };
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
    /** The source: "" for the index, "HEAD", or another ref. A restore without --source has none. */
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

// A restore's `--source` tree and the index of the word that holds it: `-sX` and `-WsX` carry it in the same word.
function restoreSource(args: string[]): [ref: string, at: number] | undefined {
    for (let k = 0; k < args.length && args[k] !== "--"; k++) {
        const s = /^-[^-]/.test(args[k]) ? args[k].indexOf("s") : -1;

        if (args[k] === "--source" || (s !== -1 && s === args[k].length - 1)) {
            return [args[k + 1] ?? "", k + 1];
        }

        if (args[k].startsWith("--source=") || s !== -1) {
            return [args[k].slice(s !== -1 ? s + 1 : "--source=".length), k];
        }
    }

    return undefined;
}

function restoreRevert(scan: ShellScan, inv: GitInvocation): Revert | null {
    const args = inv.tokens.slice(inv.sub + 1).map((t) => t.text);
    const dashAt = args.indexOf("--");
    // A word after `--` is a file: `git restore -- -m` discards the changes to a file named -m.
    const flags = (dashAt === -1 ? args : args.slice(0, dashAt)).filter((a) => a.startsWith("-"));
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
    const [ref, refAt] = restoreSource(args) ?? [undefined, -1];
    const dashToken = dashAt === -1 ? undefined : inv.tokens[inv.sub + 1 + dashAt];
    const subToken = inv.tokens[inv.sub];
    const unquotedPaths = () =>
        /["']/.test(rawTail(scan, inv, subToken.start + subToken.text.length))
            ? ""
            : args.filter((a, k) => !a.startsWith("-") && k !== refAt).join(" ");
    const files = dashToken ? rawTail(scan, inv, dashToken.start + dashToken.text.length) : unquotedPaths();
    return { inv, files, paths: wordsOf(files).args, ...(ref !== undefined ? { ref } : {}), resetsIndex: staged };
}

// `git show <ref>:<path> > <path>` writes over the file it names, like `git checkout <ref> -- <path>` but not the
// index. The stages `:1:` to `:3:` of a conflict are --ours and --theirs spelled another way. Under `git -C` the
// redirect writes the shell's folder and a status would read git's, so the path cannot be placed for a gate.
function showRevert(scan: ShellScan, inv: GitInvocation): Revert | null {
    const { args, stdout } = wordsAfter(scan, inv.tokens[inv.sub], inv.element);
    const written = stdout.filter((target) => !target.appends).map((target) => target.file);

    for (const object of written.length > 0 ? args.map(samePath) : []) {
        const colon = object.startsWith("-") ? -1 : object.indexOf(":");
        const stage = /^:([0-3]):/.exec(object);
        const path = samePath(object.slice(stage ? 3 : colon + 1));
        const file = colon === -1 ? undefined : written.find((target) => samePath(target) === path);

        if (file === undefined) {
            continue;
        }

        if (stage && stage[1] !== "0") {
            return null;
        }

        const paths = gitPlace(scan, inv) === "" ? [file] : [];
        return { inv, files: file, paths, ref: object.slice(0, colon), resetsIndex: false };
    }

    return null;
}

const REVERTS = new Map<string, (scan: ShellScan, inv: GitInvocation) => Revert | null>([
    ["checkout", checkoutRevert],
    ["restore", restoreRevert],
    ["show", showRevert],
]);

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

// Commands that write no file, so a statement of them between a fresh worktree's add and its revert makes no work the
// revert can lose. git counts only for the reads in GIT_READS.
const WRITES_NOTHING: ReadonlySet<string> = new Set([
    "cd",
    "pushd",
    "popd",
    "echo",
    "printf",
    "pwd",
    "true",
    ":",
    "ls",
    "cat",
    "test",
    "[",
    "sleep",
]);
const GIT_READS: ReadonlySet<string> = new Set(["status", "rev-parse", "log"]);

// Whether a statement surely writes no file: every part of its pipeline is a command from WRITES_NOTHING or a git
// read without `--output`, with no redirection into a file other than /dev/null, and no substitution runs another
// command (`echo "$(touch a.ts)"`).
function writesNothing(scan: ShellScan, statement: Span): boolean {
    if (/\$\(|`|[<>]\(/.test(originalSlice(scan, statement.start, elementEnd(statement)))) {
        return false;
    }

    return splitPipeline(statement).every((element) => {
        const tokens = tokenize(element);
        const cmd = commandTokenIndex(tokens, scan.command);
        const { args, writes } = wordsOf(originalSlice(scan, element.start, elementEnd(element)));

        if (cmd === -1 || writes.some((file) => samePath(file) !== "/dev/null")) {
            return false;
        }

        if (commandWord(tokens[cmd].text) !== "git") {
            return WRITES_NOTHING.has(commandWord(tokens[cmd].text));
        }

        const call = gitCall(element, scan.command);
        return (
            call !== null &&
            GIT_READS.has(call.tokens[call.sub].text) &&
            !args.some((arg) => arg.startsWith("--output"))
        );
    });
}

// `git worktree add … <dir>; … cd <dir> … <revert>`: the statement of the add, or -1. A new worktree holds no
// uncommitted work, provided nothing between the add and the revert writes a file (`echo work > a.ts` would make the
// work the revert discards). A `;` in the chain lets the revert run in an old folder when the add failed. A `||`
// skips the cd on success or runs the revert only after a failure, and a subshell or group ends its own cd: no fresh
// worktree. The revert itself must write the folder the shell is in: a `-C`, `--git-dir`, `--work-tree`, an
// assignment or a wrapper in front of git points it at another tree.
function freshWorktreeAdd(scan: ShellScan, inv: GitInvocation): number {
    if (gitPlace(scan, inv) !== "") {
        return -1;
    }

    for (let w = inv.statement - 1; w >= 0; w--) {
        const dir = worktreeAddDir(scan, inv.unit[w]);

        if (dir === null) {
            continue;
        }

        for (let k = w; k < inv.statement; k++) {
            if (!["&&", ";", "", "&"].includes(joiner(scan, inv.unit, k))) {
                return -1;
            }
        }

        let inside = false;

        for (let c = w + 1; c < inv.statement; c++) {
            const target = cdTarget(scan, inv.unit[c]);

            if (!writesNothing(scan, inv.unit[c])) {
                return -1;
            }

            if (target !== null) {
                inside = samePath(target) === samePath(dir);
            }
        }

        return inside ? w : -1;
    }

    return -1;
}

// A word the shell passes as typed and git takes as one file: no expansion, glob, pathspec magic or escape. zsh
// expands `(…)`, `|` and `<1-3>` without EXTENDED_GLOB too, and `=cmd` with EQUALS.
function literalPath(word: string): string | null {
    const path = samePath(word);
    return path === "" || /^[-:=]|[*?[\]{}()|<>^#!$`~\\'"]/.test(path) ? null : path;
}

// Before the revert, a subshell, a group, a background job, a compound command, `eval` or a sourced script can leave
// the shell in another folder than its `cd` statements name.
const UNSURE_FOLDER =
    /[(){}]|(?<![&<>|])&(?![&>])|(?:^|[;&|\n])\s*(?:(?:for|while|until|if|case|select|function|eval|source)\b|\.\s)/;

// The folder the revert's statement runs in: the payload's folder, moved by each earlier `cd <dir>` of the outer
// command that surely ran. Null when that is not certain, when the payload's folder is gone, and for a `cd` to a
// folder that does not exist, which fails and leaves the shell where it was (`<dir>/.` exists only for a folder).
function knownFolder(scan: ShellScan, inv: GitInvocation): string | null {
    if (
        !scan.cwd ||
        inv.unit !== scan.units[0] ||
        UNSURE_FOLDER.test(scan.cleaned.slice(0, inv.element.start)) ||
        !existsSync(`${scan.cwd}/.`)
    ) {
        return null;
    }

    let folder = scan.cwd;

    for (let s = 0; s < inv.statement; s++) {
        const target = cdTarget(scan, inv.unit[s]);

        if (target === null) {
            continue;
        }

        const dir = literalPath(target);
        const surely =
            s === 0 || ["", ";"].includes(joiner(scan, inv.unit, s - 1)) || andChain(scan, inv.unit, s, inv.statement);

        if (dir === null || !surely || splitPipeline(inv.unit[s]).length > 1) {
            return null;
        }

        folder = resolve(folder, dir);

        if (!existsSync(`${folder}/.`)) {
            return null;
        }
    }

    return folder;
}

// Whether nothing is at `path`, not even a dangling symlink (lstat). A check that cannot answer throws (EACCES
// in a folder nobody may search, ENOTDIR under a file), and such a path may hold a file. The throw must not leave
// here: the rules runner skips a rule whose detect throws, and all three revert rules would say nothing.
function surelyAbsent(path: string): boolean {
    try {
        return lstatSync(path, { throwIfNoEntry: false }) === undefined;
    } catch {
        return false;
    }
}

// A revert from a named source whose every path is a literal file absent where it is written only creates files.
// A statement before it may have made the file first: one that names the file or a folder on its path, a stash, a
// move or a patch. A `(` right after the last path is a zsh glob the scanner cut off.
function onlyCreates(scan: ShellScan, revert: Revert): boolean {
    const { inv } = revert;
    const paths = revert.paths.map(literalPath).filter((path) => path !== null);
    const before = scan.command.slice(0, inv.element.start);
    const named = new Set(before.split(/[\s/'"`$;&|<>(){}=:\\]+/));

    if (
        !revert.ref ||
        paths.length === 0 ||
        paths.length < revert.paths.length ||
        scan.cleaned[elementEnd(inv.element)] === "(" ||
        /\b(?:stash|mv|apply)\b/.test(before) ||
        paths.some((path) => path.split("/").some((part) => !/^\.{0,2}$/.test(part) && named.has(part)))
    ) {
        return false;
    }

    // A single `git -C <dir>` moves the folder the paths are read from. A show under -C has no paths here.
    const place = gitPlace(scan, inv);
    const moved = place === "" ? "" : literalPath(/^-C (\S+)$/.exec(place)?.[1] ?? "");
    const shell = moved === null ? null : knownFolder(scan, inv);
    const folder = shell === null || moved === null ? null : resolve(shell, moved);
    // A dangling symlink is a file the checkout replaces.
    return (
        folder !== null &&
        paths.every((path) => surelyAbsent(resolve(folder, path))) &&
        !(revert.resetsIndex && indexMayHold(folder, paths))
    );
}

// Whether the index of the repository git finds from `folder` may hold one of `paths`. A checkout from a ref also
// resets each path's index entry, and an entry staged and then deleted from the working tree exists nowhere else.
// No repository means git refuses the checkout. The index is searched as bytes: versions 2 and 3 spell each entry's
// whole path with a NUL after it, and a sparse index a folder's path with a `/`. A path names a folder too: an absent
// `lib` (or `lib/`) resets every entry under `lib/`, so any entry that spells `lib/` counts. A version 4 index
// shortens paths and a split index keeps them in a shared file, so those, an unreadable index and a `.git` file that
// names no git dir may hold every path. Case is ignored, as a case-insensitive volume does.
function indexMayHold(folder: string, paths: string[]): boolean {
    try {
        const real = realpathSync(folder);
        let top = real;

        while (!existsSync(join(top, ".git"))) {
            if (dirname(top) === top) {
                return false;
            }

            top = dirname(top);
        }

        const dotGit = join(top, ".git");
        const pointer = statSync(dotGit).isDirectory()
            ? dotGit
            : /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();

        if (!pointer) {
            return true;
        }

        const gitDir = resolve(top, pointer);
        let index: Buffer;

        try {
            index = readFileSync(join(gitDir, "index"));
        } catch (err) {
            // A repository with nothing staged yet has no index.
            return !(err instanceof Error && "code" in err && err.code === "ENOENT");
        }

        if (
            index.toString("latin1", 0, 4) !== "DIRC" ||
            ![2, 3].includes(index.readUInt32BE(4)) ||
            readdirSync(gitDir).some((name) => name.startsWith("sharedindex."))
        ) {
            return true;
        }

        const entries = index.toString("latin1").toLowerCase();

        return paths.some((path) => {
            const name = relative(top, resolve(real, path)).split(sep).join("/").toLowerCase();
            const folders = name.split("/").slice(0, -1);

            return (
                name === "" ||
                name === ".." ||
                name.startsWith("../") ||
                isAbsolute(name) ||
                /[^\x20-\x7e]/.test(name) ||
                entries.includes(`${name}\0`) ||
                entries.includes(`${name}/`) ||
                folders.some((_, k) => entries.includes(`${folders.slice(0, k + 1).join("/")}/\0`))
            );
        });
    } catch {
        return true;
    }
}

// `test -z "$(git status --porcelain --untracked-files=all --ignored -- <paths> || echo status-failed)" && `: the
// status is empty only when no path is untracked, ignored, modified or staged, so a checkout behind it overwrites
// nothing that is not committed. `--untracked-files=all` overrides a `status.showUntrackedFiles=no` that hides an
// untracked file, and `--ignored` lists an ignored file the ref tracks. A status that fails prints its error on
// stderr and nothing on stdout, so the `|| echo` fills the test and the checkout does not run.
function cleanGate(gitPart: string, paths: string[]): string {
    const status = `${gitPart}status --porcelain --untracked-files=all --ignored -- ${paths.join(" ")}`;
    return `test -z "$(${status} || echo status-failed)" && `;
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

// A revert from HEAD after a checkout, restore or show of the same paths from another ref only takes back that swap,
// provided it runs only when the swap ran (behind a `;`, a failed gate skips the swap and the revert still runs) and
// in the same tree.
function undoesOwnSwap(scan: ShellScan, inv: GitInvocation, paths: string[]): boolean {
    const place = gitPlace(scan, inv);

    for (let s = inv.statement - 1; s >= 0 && paths.length > 0; s--) {
        if (cdTarget(scan, inv.unit[s]) !== null) {
            return false;
        }

        if (!inv.unit[s].text.includes("git")) {
            continue;
        }

        const elements = splitPipeline(inv.unit[s]);

        for (let pipe = 0; pipe < elements.length; pipe++) {
            const call = gitCall(elements[pipe], scan.command);
            const read = call ? REVERTS.get(call.tokens[call.sub].text) : undefined;
            const swap = call && read?.(scan, { ...call, element: elements[pipe], unit: inv.unit, statement: s, pipe });

            if (!call || !swap?.ref || swap.ref === "HEAD" || gitPlace(scan, call) !== place) {
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

// Whether `cp <source> … <dest>` leaves a copy of `source` apart from it. cp refuses to copy a file onto itself and
// the statement after it still runs, so `cp a.ts a.ts`, `cp a.ts ./a.ts`, `cp a.ts .` and `cp sub/a.ts sub` save
// nothing. The copy lands at `dest`, or at `dest/<name>` when `dest` is a folder (or may be one). In a known folder a
// target is the source when both resolve to one path (case-folded, as on a case-insensitive volume) or both exist as
// one file (a symlink or a hard link). Without one, two relative spellings are unsure when some folder makes them one
// path (mayMeet), and an absolute and a relative one with the same last name are unsure since the shell may stand
// where the absolute one points; only an absolute target that does not exist yet is surely a new file. A word the
// shell expands is unsure too, and an unsure copy saves nothing. So does a copy whose check cannot answer (EACCES in
// a folder nobody may search, ENOTDIR under a file): cp fails there as well, and the throw must not reach the rules
// runner, which skips a rule whose detect throws and would silence all three revert rules.
function keepsCopy(folder: string | null, source: string, dest: string): boolean {
    const from = literalPath(source);
    const to = literalPath(dest);

    if (from === null || to === null) {
        return false;
    }

    const f = posix.normalize(from);
    const base = posix.basename(f);
    const located = (path: string) => (isAbsolute(path) ? path : folder === null ? null : resolve(folder, path));
    const place = located(to);

    try {
        const mayBeFolder =
            /(?:^|\/)\.{0,2}$/.test(to) || place === null || statSync(place, { throwIfNoEntry: false })?.isDirectory();
        const targets = mayBeFolder ? [to, posix.join(to, base)] : [to];

        return targets.every((target) => {
            const a = located(from);
            const b = located(target);

            if (a !== null && b !== null) {
                const left = statSync(a, { throwIfNoEntry: false });
                const right = statSync(b, { throwIfNoEntry: false });
                const oneFile =
                    left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
                return a.toLowerCase() !== b.toLowerCase() && !oneFile;
            }

            const t = posix.normalize(target);

            if (!isAbsolute(f) && !isAbsolute(t)) {
                return !mayMeet(f, t);
            }

            if (posix.basename(t).toLowerCase() !== base.toLowerCase()) {
                return true;
            }

            return isAbsolute(t) && surelyAbsent(t);
        });
    } catch {
        return false;
    }
}

// Whether two relative paths can name one file from some folder, case-folded. After the leading `..` of each, the
// path that climbs more must be the other one with exactly the extra climb's worth of folders in front: `../repo/a.ts`
// is `a.ts` from a folder named repo, while `../../bak/a.fixed.ts` is never `src/a.ts`.
function mayMeet(p: string, q: string): boolean {
    const parts = (path: string) => {
        const segments = path
            .toLowerCase()
            .split("/")
            .filter((segment) => segment !== "" && segment !== ".");
        const up = segments.findIndex((segment) => segment !== "..");
        const climb = up === -1 ? segments.length : up;
        return { climb, rest: segments.slice(climb) };
    };
    const [low, high] = [parts(p), parts(q)].sort((x, y) => x.climb - y.climb);
    const extra = high.climb - low.climb;
    return high.rest.length === low.rest.length + extra && high.rest.slice(extra).join("/") === low.rest.join("/");
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
            const dest = operands[operands.length - 1];

            if (place === "" && operands.length > 1 && samePath(dest) !== "/dev/null") {
                const folder = knownFolder(scan, revert.inv);
                kept.push(...operands.slice(0, -1).filter((source) => keepsCopy(folder, source, dest)));
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
            // zsh writes every target; bash and sh truncate each one and write only the last.
            const targets = MULTIOS_SHELLS.has(runningShell(scan, element.start)) ? stdout : stdout.slice(-1);
            const toFile = targets.some((target) => samePath(target.file) !== "/dev/null");

            // A plain `git diff` holds what differs from the index, and a revert from a ref drops the staged part too.
            if (toFile && (diffed.head || !revert.resetsIndex)) {
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
        // The gate's own double quotes would end a `bash -c "…"` body, `! test -z … && git checkout` runs the
        // checkout only when the paths are dirty, and `a || test -z … && git checkout` skips the gate when `a` succeeds.
        if (
            quote !== '"' ||
            !gateable(scan, inv) ||
            inv.tokens.slice(0, inv.git).some((t) => t.text === "!") ||
            (inv.statement > 0 && joiner(scan, inv.unit, inv.statement - 1) === "||")
        ) {
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
    /** `saved` earlier in the same unit, or in a `fresh` worktree a `;` joins: a context note, not a block. */
    kind: "blocked" | "saved" | "fresh";
    match: ShellMatch;
}

// The three rules read the same verdicts of one scan, and the file checks behind them run once.
const VERDICTS = new WeakMap<ShellScan, RevertVerdict[]>();

// Every checkout, restore or show that overwrites the working copy, in command order.
function revertVerdicts(scan: ShellScan): RevertVerdict[] {
    const cached = VERDICTS.get(scan);

    if (cached) {
        return cached;
    }

    const out: RevertVerdict[] = [];
    // From statement `from` to the end of the revert: the matched text names the save or the worktree add.
    const from = (inv: GitInvocation, s: number): ShellMatch => {
        const index = inv.unit[s].start;
        return { matched: originalSlice(scan, index, elementEnd(inv.element)), index };
    };

    for (const call of gitInvocations(scan)) {
        const revert = REVERTS.get(call.tokens[call.sub].text)?.(scan, call);

        if (!revert) {
            continue;
        }

        const { inv } = revert;
        const gitPart = scan.command.slice(inv.tokens[inv.git].start, inv.tokens[inv.sub].start);
        const fromRef = revert.ref !== undefined && revert.ref !== "" && revert.ref !== "HEAD";

        if (revert.ref === "HEAD" && undoesOwnSwap(scan, inv, revert.paths)) {
            continue;
        }

        if (fromRef && revert.paths.length > 0 && behindCleanGate(scan, inv, gitPart, revert.paths)) {
            continue;
        }

        if (onlyCreates(scan, revert)) {
            continue;
        }

        const added = freshWorktreeAdd(scan, inv);

        if (added !== -1) {
            if (!andChain(scan, inv.unit, added, inv.statement)) {
                out.push({ kind: "fresh", match: from(inv, added) });
            }

            continue;
        }

        const saved = savedFrom(scan, inv, revert);
        out.push(
            saved === null
                ? { kind: "blocked", match: blockedRevert(scan, revert, gitPart) }
                : { kind: "saved", match: from(inv, saved) }
        );
    }

    VERDICTS.set(scan, out);
    return out;
}

// The first note of `kind`, unless a revert in the same command is blocked: then the block speaks for the command.
function noteOf(scan: ShellScan, kind: RevertVerdict["kind"]): ShellMatch | null {
    const verdicts = revertVerdicts(scan);
    return verdicts.some((v) => v.kind === "blocked") ? null : (verdicts.find((v) => v.kind === kind)?.match ?? null);
}

export const gitCheckoutOverwritesFile: ShellRule = {
    id: "git-checkout-overwrites-file",
    kind: "destructive",
    title: "git checkout -- / git restore overwrites uncommitted work with no way back",
    severity: "block",
    why:
        "`git checkout -- <file>`, `git checkout HEAD -- <file>`, `git checkout <branch> -- <file>`, " +
        "`git restore <file>` and `git show <ref>:<file> > <file>` replace the working-tree copy and discard " +
        "whatever was there. Nothing records the old content, so a fix you just wrote is gone. " +
        "`git stash push -- <files>` gets the same clean tree and keeps the change recoverable. Only " +
        "`git restore --staged` (index only) is safe. A checkout, restore --source or show from another ref passes " +
        'behind `test -z "$(git status --porcelain --untracked-files=all --ignored -- <files> || echo status-failed)" ' +
        "&&`, which fails on any untracked, ignored, modified or staged file and when the status itself fails; " +
        "--ours, --theirs, -m, --merge and --conflict re-create a conflict. When the folder is known and no path exists " +
        "yet (for a checkout from a ref, in the index either), the command only creates files and passes.",
    wrong: "git checkout -- src/utils/ai/grok/models.ts",
    right: 'git stash push -m "models.ts before revert" -- src/utils/ai/grok/models.ts',
    evidence:
        "CLAUDE.md records two offences on 2026-08-27 with the rule on screen, both mutation checks that " +
        "destroyed an uncommitted fix, plus a scrubbed README regressed by `git checkout <branch> -- file`. " +
        "64 pattern hits in 30 days (Claude 60, Grok 1, Codex 3), the Codex ones all `--staged`.",
    detect(scan): ShellMatch | null {
        return revertVerdicts(scan).find((verdict) => verdict.kind === "blocked")?.match ?? null;
    },
};

export const gitCheckoutInFreshWorktree: ShellRule = {
    id: "git-checkout-in-fresh-worktree",
    kind: "destructive",
    title: "git checkout -- / git restore in a worktree this command adds, where a ; lets it run in an old folder",
    severity: "context",
    why:
        "The matched text runs from the `git worktree add` to the checkout or restore. A worktree the same command " +
        "just added holds no uncommitted work, so the revert loses nothing there, and with `&&` from the add to the " +
        "revert the guard says nothing. A statement on the way that can write a file (a redirection, a substitution or " +
        "any command but cd, echo, ls and the like) can make work there, so the revert is blocked. The only other " +
        "risk is the `;` or new line on the way: when the add fails (most " +
        "often because the folder already exists), the steps after it still run, and the revert overwrites an old " +
        "folder that can hold work. Join the add, the `cd` and the revert with `&&`.",
    wrong: "git worktree add /tmp/w/x main; cd /tmp/w/x && git checkout abc -- a.ts",
    right: "git worktree add /tmp/w/x main && cd /tmp/w/x && git checkout abc -- a.ts",
    evidence:
        "Audit of the logged firings, 2026-11-01: a checkout from another commit was blocked in a worktree the same " +
        "command had just added (`git worktree add …; echo …; cd $W && git checkout …`). The rerun printed a zero " +
        "exit and an empty status, so nothing could be lost; only the `;` after the add carried a risk.",
    detect(scan): ShellMatch | null {
        return noteOf(scan, "fresh");
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
        return noteOf(scan, "saved");
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
    gitCheckoutInFreshWorktree,
    gitCheckoutOverwritesSavedFile,
    gitPushForceWithoutLease,
];
