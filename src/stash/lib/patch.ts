import { logger } from "@app/logger";

const { log } = logger.scoped("stash:patch");

export type SaveMode = "staged" | "unstaged" | "all";

export async function runGitIn(repoDir: string, args: string[], opts?: { stdin?: string }): Promise<string> {
    log.debug({ repoDir, args }, "git invoke");
    const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
        stdin: opts?.stdin ? "pipe" : "inherit",
        stdout: "pipe",
        stderr: "pipe",
    });
    if (opts?.stdin) {
        // `proc.stdin` is typed as a union because Bun.spawn's return type depends on the literal
        // `stdin` option (which we set conditionally). The `stdin: "pipe"` branch guarantees a
        // FileSink here at runtime; the type guard reflects the invariant.
        const sink = proc.stdin;
        if (!sink || typeof sink === "number") {
            throw new Error("expected piped stdin to be a FileSink");
        }
        sink.write(opts.stdin);
        await sink.end();
    }
    const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exit !== 0) {
        // Log at debug — every caller catches and either bubbles up as an `out.log.error` or
        // intentionally swallows (e.g. probing HEAD in an empty repo). Warning here was noise.
        log.debug({ args, stderr: stderr.trim() }, "git command failed (throw)");
        throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    }
    return stdout;
}

export async function diffWorkingTree(args: { repoDir: string; mode: SaveMode }): Promise<string> {
    // --binary keeps binary diffs intact; --src/--dst-prefix=a/b matches what `git apply` expects to parse later.
    const gitArgs = ["diff", "--no-color", "--no-ext-diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/"];
    if (args.mode === "staged") {
        gitArgs.push("--cached");
    } else if (args.mode === "all") {
        gitArgs.push("HEAD");
    }
    log.debug({ mode: args.mode }, "diffWorkingTree");
    return await runGitIn(args.repoDir, gitArgs);
}

export async function applyPatch(args: { repoDir: string; patch: string; threeWay: boolean }): Promise<void> {
    const gitArgs = ["apply", "--whitespace=fix"];
    if (args.threeWay) {
        gitArgs.push("--3way");
    }
    log.debug({ repoDir: args.repoDir, threeWay: args.threeWay, bytes: args.patch.length }, "applyPatch");
    await runGitIn(args.repoDir, gitArgs, { stdin: args.patch });
}

export async function reversePatch(args: { repoDir: string; patch: string; threeWay: boolean }): Promise<void> {
    const gitArgs = ["apply", "-R", "--whitespace=fix"];
    if (args.threeWay) {
        gitArgs.push("--3way");
    }
    log.debug({ repoDir: args.repoDir, threeWay: args.threeWay }, "reversePatch");
    await runGitIn(args.repoDir, gitArgs, { stdin: args.patch });
}

export async function listFilesInPatch(args: { repoDir: string; patch: string }): Promise<string[]> {
    // First try `git apply --numstat` (handles renames/deletes correctly). Falls back to grepping
    // `+++ b/<path>` headers when git can't parse the patch (e.g. apply-target files are missing).
    const numstat = await runGitIn(args.repoDir, ["apply", "--numstat"], { stdin: args.patch }).catch(() => "");
    const fromNumstat = numstat
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split("\t").slice(2).join("\t"))
        .filter(Boolean);
    if (fromNumstat.length) {
        return fromNumstat;
    }
    // Fallback: parse the unified-diff "+++ b/<path>" lines directly.
    const paths = new Set<string>();
    for (const line of args.patch.split("\n")) {
        // Match the "after" file header of every hunk: `+++ b/path/to/file`.
        const m = /^\+\+\+ b\/(.+)$/.exec(line);
        if (m?.[1]) {
            paths.add(m[1]);
        }
    }
    return [...paths];
}
