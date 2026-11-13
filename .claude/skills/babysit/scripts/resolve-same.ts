import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import ts from "typescript";
import { HOOKS_OFF, spawnGit } from "./versions";

interface Resolution {
    text: string;
    unresolved: number;
    versions: string[];
}

const SCRIPT_KINDS = new Map<string, ts.ScriptKind>([
    [".ts", ts.ScriptKind.TS],
    [".mts", ts.ScriptKind.TS],
    [".cts", ts.ScriptKind.TS],
    [".tsx", ts.ScriptKind.TSX],
    [".js", ts.ScriptKind.JS],
    [".mjs", ts.ScriptKind.JS],
    [".cjs", ts.ScriptKind.JS],
    [".jsx", ts.ScriptKind.JSX],
]);

/** Comments and line breaks before a token, with the spaces inside and around them collapsed. */
function triviaShape(trivia: string): string {
    return trivia
        .replace(/\s+/g, (space) => (/[\n\r\p{Zl}\p{Zp}]/u.test(space) ? "\n" : " "))
        .replace(/ ?\n ?/g, "\n")
        .replace(/^ | $/g, "");
}

/**
 * The script as TypeScript reads it: each token's kind and exact text, after the comments and line breaks before it.
 * Only spaces between tokens on one line drop out, and JavaScript ignores those. A line break stays (automatic
 * semicolon insertion reads it), and a string, template, regular expression or JSX text keeps every space. null on a
 * syntax error: a parser that recovered can have split a literal into tokens.
 */
function scriptTokens(file: string, text: string, kind: ts.ScriptKind): string[] | null {
    if (ts.transpileModule(text, { fileName: file, reportDiagnostics: true }).diagnostics?.length) {
        return null;
    }

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const tokens: string[] = [];
    let end = 0;
    const visit = (node: ts.Node): void => {
        if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
            return;
        }

        const children = node.getChildren(source);
        if (children.length) {
            children.forEach(visit);
            return;
        }

        if (node.kind === ts.SyntaxKind.SyntaxList) {
            return;
        }

        // Leading spaces of JSX text are content, not trivia.
        const start = ts.isJsxText(node) ? node.pos : node.getStart(source);
        tokens.push(`${triviaShape(text.slice(end, start))}\0${node.kind}\0${text.slice(start, node.end)}`);
        end = node.end;
    };
    visit(source);
    return tokens;
}

/** JSON tokens with their exact text; JSON ignores the spaces and line breaks between them. null when not JSON. */
function jsonTokens(text: string): string[] | null {
    const token = /[ \t\n\r]*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,])/y;
    const tokens: string[] = [];
    for (;;) {
        const start = token.lastIndex;
        const match = token.exec(text);
        if (!match) {
            return /^[ \t\n\r]*$/.test(text.slice(start)) ? tokens : null;
        }

        tokens.push(match[1]);
    }
}

/**
 * Whether two versions of a file mean the same. Scripts and JSON compare token by token; every other file (Python,
 * YAML, Markdown, a Makefile, shell) only when byte-identical, since its spaces or line breaks can carry meaning.
 */
function sameMeaning(file: string, ours: string, theirs: string): boolean {
    if (ours === theirs) {
        return true;
    }

    const extension = extname(file);
    const kind = SCRIPT_KINDS.get(extension);
    const tokenize =
        kind !== undefined
            ? (text: string) => scriptTokens(file, text, kind)
            : extension === ".json"
              ? jsonTokens
              : undefined;
    if (!tokenize) {
        return false;
    }

    const a = tokenize(ours);
    const b = tokenize(theirs);
    return a !== null && b !== null && a.length === b.length && a.every((value, i) => value === b[i]);
}

function versionFile(file: string): boolean {
    return file === ".claude-plugin/marketplace.json" || /^plugins\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(file);
}

export function resolveSameText(file: string, text: string): Resolution {
    const pattern = /^<<<<<<<[^\n]*\n([\s\S]*?)^=======[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
    const matches = [...text.matchAll(pattern)];
    const versions: string[] = [];
    let unresolved = 0;
    const versionOnly = versionFile(file) && matches.length === 1;
    // The whole file with every block on one side: a block is judged in its file, so a block inside a template
    // literal compares as template text, and the result (all ours) must mean what the replayed commit (all theirs) means.
    const side = (group: 1 | 2) => {
        let out = "";
        let at = 0;
        for (const match of matches) {
            out += text.slice(at, match.index) + match[group];
            at = match.index + match[0].length;
        }
        return out + text.slice(at);
    };
    const keepOurs = !versionFile(file) && sameMeaning(file, side(1), side(2));
    const next = text.replace(pattern, (block: string, ours: string, theirs: string) => {
        if (versionFile(file)) {
            const line = /^\s*"version"\s*:\s*"([^"\n]+)"\s*,?\s*$/;
            const a = line.exec(ours);
            const b = line.exec(theirs);
            const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
            if (versionOnly && a && b && semver.test(a[1]) && semver.test(b[1])) {
                const oursHigher = Bun.semver.order(a[1], b[1]) >= 0;
                versions.push(oursHigher ? a[1] : b[1]);
                return oursHigher ? ours : theirs;
            }
        } else if (keepOurs) {
            return ours;
        }
        unresolved++;
        return block;
    });
    if (/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(next) && unresolved === 0) {
        unresolved++;
    }
    return { text: next, unresolved, versions };
}

function run(cwd: string): number {
    const git = (args: string[]) =>
        spawnGit([...HOOKS_OFF, "-c", "rerere.enabled=false", ...args], {
            cwd,
            env: { ...env.getProcessEnv(), GIT_EDITOR: "true" },
        });
    const stop = (message: string) => {
        console.log(`STOP ${message}`);
        console.log("summary: stopped");
        return 2;
    };
    if (git(["rev-parse", "--verify", "-q", "REBASE_HEAD"]).exitCode !== 0) {
        return stop("no stopped rebase in the specified worktree");
    }
    const top = git(["rev-parse", "--show-toplevel"]);
    if (top.exitCode !== 0 || realpathSync(top.stdout.toString().trim()) !== cwd) {
        return stop("--cwd must be the worktree root");
    }
    const state = git(["rev-parse", "--git-path", "rebase-merge"]);
    const stateDir = resolve(cwd, state.stdout.toString().trim());
    if (state.exitCode !== 0 || !existsSync(stateDir) || existsSync(resolve(stateDir, "drop_redundant_commits"))) {
        return stop("rebase must use the merge backend and --empty=stop or --empty=keep");
    }
    let resolved = 0;
    let skipped = 0;
    for (let round = 0; round < 1000; round++) {
        if (!existsSync(stateDir)) {
            console.log(`summary: ${resolved} files resolved, ${skipped} commits skipped`);
            return 0;
        }
        const head = git(["rev-parse", "--verify", "-q", "REBASE_HEAD"]);
        if (head.exitCode !== 0) {
            return stop("rebase is active but has no current commit");
        }
        const commit = head.stdout.toString().trim();
        const listing = git(["diff", "--name-only", "--diff-filter=U", "-z"]);
        if (listing.exitCode !== 0) {
            return stop(`${commit}: cannot list conflicts`);
        }
        const files = listing.stdout.toString().split("\0").filter(Boolean);
        for (const file of files) {
            try {
                const target = resolve(cwd, file);
                const rel = relative(cwd, target);
                const stat = lstatSync(target);
                if (
                    rel.startsWith("..") ||
                    isAbsolute(rel) ||
                    !stat.isFile() ||
                    stat.nlink !== 1 ||
                    realpathSync(target) !== target
                ) {
                    return stop(`${commit}: ${file}: unsafe path`);
                }
                const original = readFileSync(target, "utf8");
                const result = resolveSameText(file, original);
                if (result.unresolved || result.text === original) {
                    return stop(`${commit}: ${file}: real or unsupported conflict`);
                }
                if (file.endsWith(".json")) {
                    // biome-ignore lint/style/noRestrictedGlobals: This check requires strict JSON parsing.
                    JSON.parse(result.text);
                } else {
                    const ext = file.split(".").pop();
                    if (ext === "ts" || ext === "tsx" || ext === "js") {
                        new Bun.Transpiler({ loader: ext }).transformSync(result.text);
                    }
                }
                writeFileSync(target, result.text);
                const add = git(["--literal-pathspecs", "add", "--", file]);
                if (add.exitCode !== 0) {
                    return stop(`${commit}: ${file}: ${add.stderr.toString().trim()}`);
                }
                resolved++;
                console.log(
                    result.versions.length
                        ? `version kept ${result.versions[0]} ${file} ${commit}`
                        : `resolved ${file} ${commit}`
                );
            } catch (error) {
                return stop(`${commit}: ${file}: ${String(error)}`);
            }
        }
        const next = git(["rebase", "--continue"]);
        if (next.exitCode === 0) {
            continue;
        }
        const conflicts = git(["diff", "--name-only", "--diff-filter=U", "-z"]);
        if (conflicts.exitCode !== 0) {
            return stop(`${commit}: cannot inspect rebase`);
        }
        if (conflicts.stdout.length) {
            continue;
        }
        const current = git(["rev-parse", "--verify", "-q", "REBASE_HEAD"]);
        const currentCommit = current.stdout.toString().trim();
        if (current.exitCode !== 0 || currentCommit !== commit) {
            return stop(`${commit}: ${next.stderr.toString().trim()}`);
        }
        const staged = git(["diff", "--cached", "--quiet"]);
        if (staged.exitCode !== 0) {
            return stop(`${commit}: ${next.stderr.toString().trim()}`);
        }
        const cherry = git(["cherry", "HEAD", commit, `${commit}^`]);
        if (cherry.exitCode !== 0 || !new RegExp(`^- ${commit}(?:\\s|$)`).test(cherry.stdout.toString())) {
            return stop(`${commit}: empty commit is not proven upstream`);
        }
        const skip = git(["rebase", "--skip"]);
        if (skip.exitCode !== 0 && !git(["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.length) {
            return stop(`${commit}: skip failed: ${skip.stderr.toString().trim()}`);
        }
        skipped++;
        console.log(`skipped as upstream ${commit}`);
    }
    return stop("rebase exceeded 1000 stops");
}

if (import.meta.main) {
    if (process.argv.length !== 4 || process.argv[2] !== "--cwd") {
        console.error("usage: bun resolve-same.ts --cwd <worktree>");
        process.exit(2);
    }
    try {
        process.exit(run(realpathSync(process.argv[3])));
    } catch (error) {
        console.error(`STOP ${String(error)}`);
        process.exit(2);
    }
}
