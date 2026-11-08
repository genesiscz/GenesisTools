import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { HOOKS_OFF } from "./versions";

interface Resolution {
    text: string;
    unresolved: number;
    versions: string[];
}

// Whitespace inside strings, templates, comments or regular expressions can change behavior.
function normalize(text: string): string {
    // A slash may start a comment or a regular expression. Keep such blocks exact.
    if (text.includes("/")) {
        return text;
    }
    let result = "";
    let protectedText = "";
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (protectedText) {
            result += c;
            if (c === "\\") {
                result += text[++i] ?? "";
            } else if (c === protectedText) {
                protectedText = "";
            }
        } else if (c === '"' || c === "'" || c === "`") {
            protectedText = c;
            result += c;
        } else if (/[\]})]/.test(c) && result.endsWith(",")) {
            result = `${result.slice(0, -1)}${c}`;
        } else if (!/\s/.test(c)) {
            result += c;
        } else {
            const before = result.at(-1) ?? "";
            const after = text.slice(i + 1).match(/^\s*(.)/s)?.[1] ?? "";
            if (
                (/[\w$]/.test(before) && /[\w$]/.test(after)) ||
                (/[+\-<>=&|?]/.test(before) && /[+\-<>=&|?]/.test(after))
            ) {
                result += " ";
            }
        }
    }
    return result;
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
    const next = text.replace(pattern, (block: string, ours: string, theirs: string) => {
        if (versionFile(file)) {
            const line = /^\s*"version"\s*:\s*"([^"\n]+)"\s*,?\s*$/;
            const a = line.exec(ours);
            const b = line.exec(theirs);
            const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
            if (versionOnly && a && b && semver.test(a[1]) && semver.test(b[1])) {
                const keepOurs = Bun.semver.order(a[1], b[1]) >= 0;
                versions.push(keepOurs ? a[1] : b[1]);
                return keepOurs ? ours : theirs;
            }
        } else if (normalize(ours) === normalize(theirs)) {
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
        Bun.spawnSync(["git", ...HOOKS_OFF, "-c", "rerere.enabled=false", ...args], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
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
