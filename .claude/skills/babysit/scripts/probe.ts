/**
 * The personal-data probe for a push whose full gates do not apply (another repository's PR, `integrate --skip-gates`).
 * The probe must run before every push, but such a repository can carry older hits that are not the round's doing
 * (2026-10-14, GenesisPlayground #94: 83 older hits in 34 files). So this runs this checkout's probe on the target
 * worktree and fails only on a hit in a line the pushed range adds. It prints file and line, never the matched text.
 */
import { join } from "node:path";

/** `path:line` for every probe hit that falls on a line `diffU0` (`git diff -U0 a..b`) adds. */
export function hitsInAddedLines(probeOutput: string, diffU0: string): string[] {
    const hits = new Map<string, Set<number>>();

    for (const match of probeOutput.matchAll(/^\s+([^:\s]+):(\d+):/gm)) {
        const lines = hits.get(match[1]) ?? new Set<number>();
        lines.add(Number(match[2]));
        hits.set(match[1], lines);
    }

    const found: string[] = [];
    let file = "";

    for (const line of diffU0.split("\n")) {
        const header = /^\+\+\+ b\/(.+)$/.exec(line);

        if (header) {
            file = header[1];
            continue;
        }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);

        if (!hunk) {
            continue;
        }

        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);

        for (let n = start; n < start + count; n++) {
            if (hits.get(file)?.has(n)) {
                found.push(`${file}:${n}`);
            }
        }
    }

    return found;
}

/** Runs the probe on `wt` and reports; returns false when the push must not happen. */
export function probeAddedLines({ wt, from, to }: { wt: string; from: string; to: string }): boolean {
    const script = join(import.meta.dir, "../../../../scripts/ci/placeholder-check.sh");
    const probe = Bun.spawnSync(["bash", script, wt], { stdout: "pipe", stderr: "pipe", env: process.env });
    const out = `${probe.stdout.toString()}${probe.stderr.toString()}`;

    if (probe.exitCode === 0) {
        console.log("✔ personal-data probe: no hit");
        return true;
    }

    const older = out.match(/^\s+[^:\s]+:\d+:/gm)?.length ?? 0;

    if (probe.exitCode !== 1 || older === 0) {
        console.log(`✖ personal-data probe exit ${probe.exitCode} with no hit list: it checked nothing`);
        return false;
    }

    const diff = Bun.spawnSync(["git", "diff", "-U0", `${from}..${to}`], {
        cwd: wt,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });

    if (diff.exitCode !== 0) {
        console.log(`✖ git diff ${from}..${to} failed: ${diff.stderr.toString().slice(0, 200)}`);
        return false;
    }

    const added = hitsInAddedLines(out, diff.stdout.toString());

    if (added.length > 0) {
        console.log(`✖ personal-data probe: ${added.length} hit(s) in lines this push adds: ${added.join(", ")}`);
        return false;
    }

    console.log(`✔ personal-data probe: ${older} older hit(s), none in a line this push adds`);
    return true;
}
