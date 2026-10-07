import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("stash:patch");

export type SaveMode = "staged" | "unstaged" | "all" | "regions" | "patch";

export async function runGitIn(repoDir: string, args: string[], opts?: { stdin?: string }): Promise<string> {
    log.debug({ repoDir, args }, "git invoke");
    const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
        stdin: opts?.stdin ? "pipe" : "inherit",
        stdout: "pipe",
        stderr: "pipe",
    });
    // Start the stdout/stderr/exit readers BEFORE writing stdin. Without this, a streaming git
    // subcommand or input larger than the OS pipe buffer (~16-64 KB on macOS) deadlocks because
    // stdin.end() waits for the pipe to drain while no reader is consuming stdout.
    const drain = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
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
    const [stdout, stderr, exit] = await drain;
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
    } else if (args.mode === "all" || args.mode === "regions" || args.mode === "patch") {
        // "regions" and "patch" use the full working-tree diff; each mode narrows downstream.
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

/**
 * Paths `git apply --numstat -z` reports, decoded (no C-quoting) because `-z` turns quoting off.
 * A rename reports only its destination, so callers that need the source too read the reversed
 * patch as well: its "destination" is the original path.
 */
async function numstatPaths(args: { repoDir: string; patch: string; reverse: boolean }): Promise<string[]> {
    const gitArgs = args.reverse ? ["apply", "-R", "--numstat", "-z"] : ["apply", "--numstat", "-z"];
    const numstat = await runGitIn(args.repoDir, gitArgs, { stdin: args.patch }).catch((err) => {
        log.debug({ err, reverse: args.reverse }, "git apply --numstat could not parse the patch");
        return "";
    });
    return numstat
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.split("\t").slice(2).join("\t"))
        .filter(Boolean);
}

function patchHeaderPaths(patch: string, sides: "after" | "both"): string[] {
    const paths = new Set<string>();
    const header = sides === "both" ? /^(?:\+\+\+ b|--- a)\/(.+)$/ : /^\+\+\+ b\/(.+)$/;
    for (const line of patch.split("\n")) {
        const m = header.exec(line);
        if (m?.[1]) {
            paths.add(m[1]);
        }
    }
    return [...paths];
}

export async function listFilesInPatch(args: { repoDir: string; patch: string }): Promise<string[]> {
    // First try `git apply --numstat -z` (handles renames/deletes and unquotes odd names). Falls back
    // to grepping `+++ b/<path>` headers when git can't parse the patch (e.g. apply-target files are missing).
    const fromNumstat = await numstatPaths({ ...args, reverse: false });
    if (fromNumstat.length) {
        return fromNumstat;
    }
    return patchHeaderPaths(args.patch, "after");
}

/** Every path the patch touches, both sides of a rename included: what a recovery snapshot must cover. */
export async function listPatchPaths(args: { repoDir: string; patch: string }): Promise<string[]> {
    const forward = await numstatPaths({ ...args, reverse: false });
    if (!forward.length) {
        return patchHeaderPaths(args.patch, "both");
    }
    const reverse = await numstatPaths({ ...args, reverse: true });
    return [...new Set([...forward, ...reverse])];
}
