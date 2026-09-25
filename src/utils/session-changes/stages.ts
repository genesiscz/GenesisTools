import { basename } from "node:path";
import { RESERVED_PREFIX } from "@genesiscz/utils/shell/scan";

/**
 * How each program a shell command runs treats files: `stageOf` classifies one simple command
 * (program plus arguments, and a heredoc on its stdin) as a reader, a test run, a build, an
 * install, a git rewrite, or a writer with the targets it names.
 */

/**
 * What one pipeline stage does to files.
 * - `read`: nothing (inspection, git reads, typechecks, `tools say`).
 * - `test` / `build` / `install`: writes only its own artifacts, never source it does not name.
 * - `git-rewrite`: git rewrites the working tree (checkout, rebase, stash, commit hooks, ...).
 * - `write`: changes files, named or not (editors, codemods, formatters, unknown programs).
 */
export type StageKind = "read" | "test" | "build" | "install" | "git-rewrite" | "write";

export const WRAPPERS = new Set(["command", "builtin", "exec", "env", "sudo", "nohup", "time", "caffeinate", "stdbuf"]);
export const WRAPPERS_WITH_NUMBER = new Set(["timeout", "nice", "gtimeout"]);

/**
 * Programs that never write a file they are not redirected into. `eval` and `osascript` run any
 * command text, so they are not here; `find`, `plutil` and `gh` write only for some arguments.
 */
const READERS = new Set(
    (
        "cat head tail less more rg grep egrep fgrep ls fd find wc sort uniq cut tr echo printf pwd cd which type test [ [[ " +
        "true false sleep date stat file du df diff cmp jq yq awk gawk sed basename dirname realpath readlink export set " +
        "unset source . alias tree bat column nl od xxd hexdump strings shasum md5 sha1sum sha256sum base64 gh open " +
        "ps kill pkill pgrep lsof top vm_stat sysctl defaults sw_vers uname whoami id hostname for done fi esac " +
        "case read wait exit return local declare typeset let shift break continue mdfind mdls plutil codesign otool " +
        "nm file log launchctl security spctl xcrun xcode-select man help history jobs fg bg disown trap ulimit umask " +
        "tput clear say afplay pbpaste pbcopy ping dig nslookup host ssh-add printenv seq yes " +
        "numfmt expr bc dc cal"
    ).split(/\s+/)
);

const GIT_READ = new Set(
    (
        "status log diff show rev-parse branch remote fetch push ls-files ls-tree ls-remote blame describe merge-base " +
        "for-each-ref cat-file grep config tag notes shortlog reflog count-objects fsck var help version rev-list name-rev " +
        "symbolic-ref check-ignore check-attr range-diff whatchanged add hash-object show-ref diff-tree diff-index " +
        "diff-files verify-commit cherry annotate archive bundle"
    ).split(/\s+/)
);

const GIT_REWRITE = new Set(
    (
        "checkout switch rebase merge stash reset pull cherry-pick revert am commit bisect clean worktree clone " +
        "submodule sparse-checkout restore filter-branch gc prune"
    ).split(/\s+/)
);

const LOCK_OR_MANIFEST = new Set([
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "Cargo.lock",
    "poetry.lock",
    "pyproject.toml",
    "requirements.txt",
    "uv.lock",
    "composer.json",
    "composer.lock",
    "Podfile.lock",
    "Package.resolved",
    "go.mod",
    "go.sum",
    "Gemfile.lock",
]);

export function isLockOrManifest(path: string): boolean {
    return LOCK_OR_MANIFEST.has(basename(path));
}

export interface StageResult {
    kind: StageKind;
    /** Raw path arguments the stage writes, not yet resolved. */
    writes: string[];
    /** Raw directory arguments the stage writes under. */
    dirs?: string[];
    /** The directory relative `writes` resolve against, when the program takes one (`--cwd`). */
    base?: string;
    /** Raw paths a script mentions (see `CommandAnalysis.hints`). */
    hints?: string[];
    unnamed: boolean;
    installs?: boolean;
    snapshots?: boolean;
}

const read = (): StageResult => ({ kind: "read", writes: [], unnamed: false });
const unknownWriter = (): StageResult => ({ kind: "write", writes: [], unnamed: true });

function nonFlags(args: string[]): string[] {
    return args.filter((arg) => !arg.startsWith("-"));
}

function afterDoubleDash(args: string[]): string[] {
    const at = args.indexOf("--");
    return at === -1 ? [] : args.slice(at + 1);
}

function flagValue(args: string[], names: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";

        for (const name of names) {
            if (arg === name) {
                return args[i + 1] ?? null;
            }

            if (arg.startsWith(`${name}=`)) {
                return arg.slice(name.length + 1);
            }
        }
    }

    return null;
}

function gitStage(args: string[]): StageResult {
    let i = 0;

    while (i < args.length && (args[i] ?? "").startsWith("-")) {
        i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i] ?? "") ? 2 : 1;
    }

    const verb = args[i] ?? "";
    const rest = args.slice(i + 1);

    if (verb === "restore") {
        const pathspec = afterDoubleDash(rest);
        const named = pathspec.length > 0 ? pathspec : nonFlags(rest.filter((_, at) => rest[at - 1] !== "-s"));
        return { kind: "write", writes: named, unnamed: false };
    }

    if (verb === "checkout" && rest.includes("--")) {
        return { kind: "write", writes: afterDoubleDash(rest), unnamed: false };
    }

    if (verb === "apply") {
        return { kind: "write", writes: [], unnamed: !rest.includes("--cached") && !rest.includes("--check") };
    }

    if (verb === "mv") {
        return { kind: "write", writes: nonFlags(rest), unnamed: false };
    }

    if (verb === "rm") {
        const paths = rest.includes("--cached") ? [] : nonFlags(rest);
        return rest.some((arg) => RECURSIVE.test(arg))
            ? { kind: "write", writes: [], dirs: paths, unnamed: false }
            : { kind: "write", writes: paths, unnamed: false };
    }

    if (verb === "stash" && (rest[0] === "list" || rest[0] === "show")) {
        return read();
    }

    if (verb === "worktree" && rest[0] === "list") {
        return read();
    }

    if (GIT_REWRITE.has(verb)) {
        return { kind: "git-rewrite", writes: [], unnamed: false };
    }

    if (GIT_READ.has(verb) || verb === "") {
        return read();
    }

    return unknownWriter();
}

const TEST_SCRIPT = /^test(?::|$)/;
const BUILD_SCRIPT = /^(?:app|build|bundle|compile|dist)(?::|$)/;
const CHECK_SCRIPT = /^(?:typecheck|tsc|tsgo|lint|check|types)(?::|$)/;
const SNAPSHOT_FLAGS = new Set(["-u", "--update-snapshots", "--updateSnapshot", "--update"]);

function packageScript(script: string, args: string[]): StageResult | null {
    if (TEST_SCRIPT.test(script)) {
        return { kind: "test", writes: [], unnamed: false, snapshots: args.some((arg) => SNAPSHOT_FLAGS.has(arg)) };
    }

    if (BUILD_SCRIPT.test(script)) {
        return { kind: "build", writes: [], unnamed: false };
    }

    if (CHECK_SCRIPT.test(script) && !/fix|write|format/.test(script)) {
        return read();
    }

    return null;
}

const INSTALL_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
    bun: new Set(["install", "i", "add", "a", "remove", "rm", "update", "upgrade", "link", "unlink"]),
    npm: new Set(["install", "i", "ci", "uninstall", "un", "remove", "update", "add"]),
    pnpm: new Set(["install", "i", "add", "remove", "rm", "update", "up"]),
    yarn: new Set(["", "install", "add", "remove", "upgrade", "up"]),
    pip: new Set(["install", "uninstall"]),
    pip3: new Set(["install", "uninstall"]),
    uv: new Set(["add", "remove", "sync", "lock", "pip"]),
    pod: new Set(["install", "update"]),
    cargo: new Set(["add", "remove", "update"]),
    composer: new Set(["install", "require", "update", "remove"]),
    go: new Set(["get", "mod"]),
    brew: new Set(["install", "upgrade", "uninstall", "reinstall"]),
};

function runnerStage(program: string, args: string[]): StageResult | null {
    const sub = args[0] ?? "";
    const install = INSTALL_VERBS[program];

    if (install?.has(sub)) {
        return { kind: "install", writes: [], unnamed: false, installs: true };
    }

    if (program === "bun" || program === "npm" || program === "pnpm" || program === "yarn") {
        if (sub === "test" || (program === "bun" && sub === "scripts/test.ts")) {
            return { kind: "test", writes: [], unnamed: false, snapshots: args.some((arg) => SNAPSHOT_FLAGS.has(arg)) };
        }

        if (sub === "run" && args[1]) {
            return packageScript(args[1], args.slice(2)) ?? unknownWriter();
        }

        if (sub === "build") {
            return { kind: "build", writes: [], unnamed: false };
        }

        if (program !== "bun" && packageScript(sub, args.slice(1))) {
            return packageScript(sub, args.slice(1));
        }

        if (sub === "x" || sub === "exec" || sub === "dlx") {
            return stageOf({ program: args[1] ?? "", args: args.slice(2) });
        }

        return program === "bun" && (sub === "--version" || sub === "pm") ? read() : unknownWriter();
    }

    if (program === "swift" || program === "cargo" || program === "go") {
        if (sub === "test") {
            return { kind: "test", writes: [], unnamed: false };
        }

        if (["build", "check", "clippy", "vet", "run", "bench"].includes(sub)) {
            return { kind: "build", writes: [], unnamed: false };
        }

        if (program === "swift" && sub === "package") {
            return { kind: "install", writes: [], unnamed: false, installs: true };
        }

        if (program === "go" && (sub === "fmt" || sub === "generate")) {
            return unknownWriter();
        }

        return program === "swift" && (sub === "--version" || sub === "") ? read() : unknownWriter();
    }

    return null;
}

const FORMATTERS = new Set([
    "prettier",
    "biome",
    "eslint",
    "ruff",
    "black",
    "gofmt",
    "goimports",
    "rustfmt",
    "swiftformat",
    "swift-format",
    "dprint",
    "stylelint",
]);
const FORMAT_WRITE_FLAGS = new Set(["--write", "--fix", "--apply", "--apply-unsafe", "-w", "--in-place", "-i"]);
const FORMATTER_VERBS = new Set(["check", "format", "lint", "fmt", "ci", "format-file"]);

function formatterStage(program: string, args: string[]): StageResult {
    const writes =
        args.some((arg) => FORMAT_WRITE_FLAGS.has(arg.split("=")[0] ?? "")) ||
        (program === "black" && !args.includes("--check")) ||
        (program === "ruff" && args[0] === "format" && !args.includes("--check")) ||
        (program === "rustfmt" && !args.includes("--check")) ||
        (program === "dprint" && args[0] === "fmt");

    if (!writes) {
        return read();
    }

    const paths = nonFlags(args).filter((arg) => !FORMATTER_VERBS.has(arg));
    return { kind: "write", writes: paths, unnamed: paths.length === 0 };
}

/** `sed -i`, `perl -i`, `awk -i inplace`: the file arguments are the targets, the script is not. */
function inPlaceStage(program: string, rawArgs: string[]): StageResult {
    // BSD sed takes the backup suffix as its own argument: `sed -i '' 's/a/b/' f`.
    const suffixAt = rawArgs.findIndex((arg, index) => arg === "-i" && index + 1 < rawArgs.length);
    const args =
        suffixAt !== -1 && program.endsWith("sed") && /^(?:|\.[\w.~-]*)$/.test(rawArgs[suffixAt + 1] ?? "x")
            ? rawArgs.filter((_, index) => index !== suffixAt + 1)
            : rawArgs;
    const inPlace = args.some(
        (arg) =>
            (/^-[A-Za-z]*i/.test(arg) && !arg.startsWith("--")) ||
            arg.startsWith("--in-place") ||
            (program.endsWith("awk") && arg === "inplace")
    );

    if (!inPlace) {
        return program === "perl" || program === "ruby" ? unknownWriter() : read();
    }

    const files: string[] = [];
    let scriptTaken = args.some((arg) => arg === "-e" || arg === "-f" || /^-[A-Za-z]*e$/.test(arg));

    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";

        if (arg === "-e" || arg === "-f" || /^-[A-Za-z]*e$/.test(arg) || (arg === "-i" && program.endsWith("awk"))) {
            i++;
            continue;
        }

        if (arg.startsWith("-")) {
            continue;
        }

        if (!scriptTaken) {
            scriptTaken = true;
            continue;
        }

        files.push(arg);
    }

    return { kind: "write", writes: files, unnamed: files.length === 0 };
}

const RECURSIVE = /^-[A-Za-z]*[rR]/;

function fsStage(program: string, args: string[]): StageResult | null {
    const paths = nonFlags(args);
    const recursive = args.some((arg) => RECURSIVE.test(arg) || arg === "--recursive");

    switch (program) {
        case "mkdir":
        case "rmdir":
            return { kind: "write", writes: [], dirs: paths, unnamed: false };
        case "rm":
            return recursive
                ? { kind: "write", writes: [], dirs: paths, unnamed: false }
                : { kind: "write", writes: paths, unnamed: false };
        case "unlink":
        case "touch":
        case "truncate":
        case "tee":
        case "shred":
            return { kind: "write", writes: paths, unnamed: false };
        case "mv": {
            const target = paths.at(-1) ?? "";
            const intoDir = target.endsWith("/") || paths.length > 2;
            return intoDir
                ? { kind: "write", writes: paths.slice(0, -1), dirs: [target], unnamed: false }
                : { kind: "write", writes: paths, unnamed: false };
        }
        case "chmod":
        case "chown":
        case "chgrp":
            return recursive
                ? { kind: "write", writes: [], dirs: paths.slice(1), unnamed: false }
                : { kind: "write", writes: paths.slice(1), unnamed: false };
        case "cp":
        case "ln":
        case "install":
        case "rsync":
        case "ditto":
        case "screencapture": {
            const target = paths.slice(-1);
            const intoDir =
                recursive ||
                program === "rsync" ||
                program === "ditto" ||
                (target[0] ?? "").endsWith("/") ||
                paths.length > 2;
            return intoDir
                ? { kind: "write", writes: [], dirs: target, unnamed: false }
                : { kind: "write", writes: target, unnamed: false };
        }
        case "dd": {
            const target = args.find((arg) => arg.startsWith("of="));
            return { kind: "write", writes: target ? [target.slice(3)] : [], unnamed: false };
        }
        case "curl":
        case "wget": {
            const out = flagValue(args, ["-o", "--output", "--output-document"]);

            if (out) {
                return { kind: "write", writes: [out], unnamed: false };
            }

            return args.includes("-O") || program === "wget" ? unknownWriter() : read();
        }
        case "patch": {
            const target = paths[0];
            return { kind: "write", writes: target ? [target] : [], unnamed: !target };
        }
        case "unzip":
        case "tar": {
            const dir = flagValue(args, ["-d", "-C", "--directory"]);
            const creates = program === "tar" && /^-?[a-z]*c/.test(args[0] ?? "");
            const file = creates ? flagValue(args, ["-f", "--file"]) : null;

            if (file) {
                return { kind: "write", writes: [file], unnamed: false };
            }

            return dir ? { kind: "write", writes: [], dirs: [dir], unnamed: false } : unknownWriter();
        }
        default:
            return null;
    }
}

const TEST_RUNNERS = new Set(["jest", "vitest", "pytest", "mocha", "ava", "playwright", "phpunit", "rspec"]);
const BUILDERS = new Set([
    "xcodebuild",
    "make",
    "cmake",
    "ninja",
    "swiftc",
    "clang",
    "gcc",
    "cc",
    "vite",
    "webpack",
    "rollup",
    "esbuild",
    "gradle",
]);
const TYPECHECKERS = new Set(["tsc", "tsgo", "vue-tsc"]);

const INLINE_RUNTIMES = new Set(["python", "python3", "node", "bun", "deno", "ruby"]);
/** A file-writing API inside an inline script (`python3 -c`, `bun -e`). Without one the script only prints. */
const INLINE_WRITES =
    /\bopen\s*\([^)]*,\s*['"][wax]|\.write\s*\(|write_text|write_bytes|\bos\.(?:remove|rename|replace|unlink|makedirs|mkdir|rmdir)|\bshutil\.|writeFile|appendFile|Bun\.write|unlinkSync|\bunlink\(|rmSync|\brm\(|renameSync|mkdirSync|copyFile|cpSync|Deno\.write|File\.write|FileUtils/;

/** A quoted relative or absolute file path with an extension inside script code: `"src/a.ts"`. */
const PATH_LITERAL = /["'`]((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]+)["'`]/g;

/**
 * The code of `python3 -c <code>`, `bun -e <code>` or `python3 - <<EOF`, or null when the
 * command runs a file instead.
 */
function inlineScript(program: string, args: string[], stdin: string | null): string | null {
    if (!INLINE_RUNTIMES.has(program)) {
        return null;
    }

    const flag = args.findIndex(
        (arg) => arg === "-c" || arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print"
    );

    if (flag !== -1) {
        return args[flag + 1] ?? "";
    }

    return stdin !== null && (args.length === 0 || args.every((arg) => arg === "-" || arg.startsWith("-")))
        ? stdin
        : null;
}

/** An inline script that writes names the files it writes as literals, when it names them at all. */
function inlineStage(code: string): StageResult {
    if (!INLINE_WRITES.test(code)) {
        return read();
    }

    const literals = [...code.matchAll(PATH_LITERAL)].map((match) => match[1] ?? "").filter((path) => path.length > 0);
    return { kind: "write", writes: [], hints: [...new Set(literals)], unnamed: true };
}

/**
 * The files a fable-replace marker spec edits: every `@@ <path>` section header, and the
 * `to=<path>` of a `move` op. Lines inside a `<<<` ... `>>>` block are body text, not headers.
 */
export function fableSpecPaths(spec: string): string[] {
    const paths: string[] = [];
    let inBlock = false;

    for (const line of spec.split(/\r?\n/)) {
        if (inBlock) {
            inBlock = line !== ">>>";
            continue;
        }

        if (line.startsWith("@@")) {
            const path = line.slice(2).trim();

            if (path.length > 0 && !paths.includes(path)) {
                paths.push(path);
            }

            continue;
        }

        if (line.startsWith("<<<")) {
            const to = /\bto=(\S+)/.exec(line)?.[1];

            if (to && !paths.includes(to)) {
                paths.push(to);
            }

            inBlock = true;
        }
    }

    return paths;
}

/**
 * fable-replace edits exactly the files its spec names. The spec is read from the heredoc, or
 * from a `--spec` file an earlier stage of the same command wrote from a heredoc; a spec from
 * anywhere else (a pipe, an older file) leaves the targets unknown.
 */
function fableStage(
    args: string[],
    stdin: string | null,
    specFile: (raw: string) => string | null
): StageResult | null {
    const specPath = flagValue(args, ["--spec"]);
    const spec = specPath === null ? stdin : specFile(specPath);
    const runsFable =
        args.some((arg) => arg.includes("fable-replace")) ||
        (spec !== null && args.some((arg) => /(?:^|\/)cli\.ts$/.test(arg)) && fableSpecPaths(spec).length > 0);

    if (!runsFable) {
        return null;
    }

    const paths = spec === null ? [] : fableSpecPaths(spec);
    const base = flagValue(args, ["--cwd"]) ?? undefined;
    return { kind: "write", writes: paths, base, unnamed: paths.length === 0 };
}

interface StageInput {
    program: string;
    args: string[];
    /** The heredoc body fed to the command's stdin, when the text carries one. */
    stdin?: string | null;
    /** The text an earlier stage of the same command wrote to this path from a heredoc (`cat > f <<EOF`). */
    specFile?: (raw: string) => string | null;
}

/** Subcommands that only report: `tools <tool> status`, `tools github review list`. */
const REPORT_VERBS = new Set(
    (
        "status list ls show get doctor check info view log logs tail search find diff help --help -h version " +
        "whoami usage stats query read cat inspect explain readme --readme print dump skeleton describe"
    ).split(/\s+/)
);

/** GenesisTools' own CLI: a few subcommands are known builds or git rewrites, a report verb only reads. */
function toolsStage(args: string[]): StageResult {
    const tool = args[0] ?? "";

    if (tool === "say" || tool === "notify" || (tool === "github" && args[1] === "review")) {
        return read();
    }

    if (tool === "macos" && args[1] === "permissions" && args[2] === "build") {
        return { kind: "build", writes: [], unnamed: false };
    }

    if ((tool === "github" && args[1] === "merge") || (tool === "git" && args[1] === "rebase-cascade")) {
        return { kind: "git-rewrite", writes: [], unnamed: false };
    }

    if (args.slice(1, 4).some((arg) => REPORT_VERBS.has(arg))) {
        return read();
    }

    return unknownWriter();
}

export const SCRIPT_RUNNERS = new Set(["bun", "node", "tsx", "deno", "python", "python3", "bash", "sh", "zsh", "ruby"]);
/** A script whose name says it tests or only checks: `selftest.ts`, `check-package-boundaries.ts`, `lint-rules.ts`. */
const TEST_SCRIPT_NAME = /(?:^|[-_.])(?:self)?(?:test|tests|spec|e2e)(?:[-_.]|$)/i;
const CHECK_SCRIPT_NAME =
    /(?:^|[-_.])(?:check|checks|lint|guard|verify|validate|probe|doctor|status|report|list|show|watch|wait|poll|monitor|bench|benchmark|parity|compare|audit)(?:[-_.]|$)/i;

/** A script run by path (`bun scripts/x.ts`, `bash x.sh`) classified by its file name. */
function scriptStage(program: string, args: string[]): StageResult | null {
    if (!SCRIPT_RUNNERS.has(program)) {
        return null;
    }

    const file = args.find((arg) => !arg.startsWith("-"));

    if (!file || !/\.(?:[cm]?[jt]sx?|py|sh|zsh|rb)$/.test(file)) {
        return null;
    }

    const name = basename(file).replace(/\.[^.]+$/, "");

    if (TEST_SCRIPT_NAME.test(name)) {
        return { kind: "test", writes: [], unnamed: false };
    }

    return CHECK_SCRIPT_NAME.test(name) ? read() : null;
}

/** `plutil` writes the result back over the file for these, unless `-o -` sends it to stdout. */
const PLUTIL_WRITES = new Set(["-convert", "-create", "-extract", "-insert", "-remove", "-replace"]);

function plutilWrites(args: string[]): boolean {
    const toStdout = args.some((arg, index) => arg === "-o" && args[index + 1] === "-");
    return !toStdout && args.some((arg) => PLUTIL_WRITES.has(arg));
}

/** `gh` subcommands that write files into the working directory. */
const GH_WRITES = new Set(["release download", "run download", "repo clone", "gist clone"]);

/** Classify one simple command by its program and arguments. */
export function stageOf({ program, args, stdin = null, specFile = () => null }: StageInput): StageResult {
    if (program === "" || RESERVED_PREFIX.has(program)) {
        return read();
    }

    if (program === "git") {
        return gitStage(args);
    }

    if (
        program === "sed" ||
        program === "gsed" ||
        program === "perl" ||
        program === "ruby" ||
        program.endsWith("awk")
    ) {
        return inPlaceStage(program, args);
    }

    if (FORMATTERS.has(program)) {
        return formatterStage(program, args);
    }

    if (TEST_RUNNERS.has(program)) {
        return { kind: "test", writes: [], unnamed: false, snapshots: args.some((arg) => SNAPSHOT_FLAGS.has(arg)) };
    }

    if (TYPECHECKERS.has(program)) {
        return args.includes("--noEmit") ? read() : { kind: "build", writes: [], unnamed: false };
    }

    if (BUILDERS.has(program)) {
        return { kind: args.includes("test") ? "test" : "build", writes: [], unnamed: false };
    }

    if (program === "bunx" || program === "npx" || program === "pnpx") {
        return stageOf({ program: basename(args[0] ?? ""), args: args.slice(1), stdin });
    }

    if (program === "tools") {
        return toolsStage(args);
    }

    if (program === "gh" && args[0] === "pr" && args[1] === "checkout") {
        return { kind: "git-rewrite", writes: [], unnamed: false };
    }

    const script = scriptStage(program, args);

    if (script) {
        return script;
    }

    if (INLINE_RUNTIMES.has(program)) {
        const fable = fableStage(args, stdin, specFile);

        if (fable) {
            return fable;
        }
    }

    const inline = inlineScript(program, args, stdin);

    if (inline !== null) {
        return inlineStage(inline);
    }

    const runner = runnerStage(program, args);

    if (runner) {
        return runner;
    }

    const fs = fsStage(program, args);

    if (fs) {
        return fs;
    }

    if (READERS.has(program)) {
        if (
            (program === "find" &&
                args.some((arg) => arg === "-delete" || arg.startsWith("-exec") || arg.startsWith("-fprint"))) ||
            (program === "plutil" && plutilWrites(args)) ||
            (program === "gh" && GH_WRITES.has(`${args[0] ?? ""} ${args[1] ?? ""}`))
        ) {
            return unknownWriter();
        }

        return read();
    }

    return unknownWriter();
}
