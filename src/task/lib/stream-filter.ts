export function resolveStreamFilter(opts: { stdout?: boolean; stderr?: boolean }): Set<"stdout" | "stderr"> {
    const hasStdout = opts.stdout === true;
    const hasStderr = opts.stderr === true;

    if (!hasStdout && !hasStderr) {
        return new Set(["stdout", "stderr"]);
    }

    const allowed = new Set<"stdout" | "stderr">();
    if (hasStdout) {
        allowed.add("stdout");
    }

    if (hasStderr) {
        allowed.add("stderr");
    }

    return allowed;
}
