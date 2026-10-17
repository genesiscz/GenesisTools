/**
 * The personal-data probe for a push whose full gates do not apply (another repository's PR, `integrate --skip-gates`).
 * The probe must run before every push, but such a repository can carry older hits that are not the round's doing
 * (2026-10-14, GenesisPlayground #94: 83 older hits in 34 files). So this runs this checkout's probe on the target
 * worktree and fails only on a hit in a line the pushed range adds. It prints file and line, never the matched text.
 */

import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

/** Git's core.quotePath=true spelling, matched against known filenames rather than guessing where a path ends. */
function quotedPath(file: string): string {
    const escapes: Record<number, string> = {
        7: "\\a",
        8: "\\b",
        9: "\\t",
        10: "\\n",
        11: "\\v",
        12: "\\f",
        13: "\\r",
        34: '\\"',
        92: "\\\\",
    };
    return (
        '"' +
        [...Buffer.from(file)]
            .map(
                (byte) =>
                    escapes[byte] ??
                    (byte < 32 || byte >= 127 ? "\\" + byte.toString(8).padStart(3, "0") : String.fromCharCode(byte))
            )
            .join("") +
        '"'
    );
}

function probeHits(output: string, files?: readonly string[]): Array<{ file: string; line: number } | null> {
    const paths = new Map<string, Set<string>>();
    for (const file of files ?? []) {
        for (const spelling of [file, quotedPath(file)]) {
            const matches = paths.get(spelling) ?? new Set<string>();
            matches.add(file);
            paths.set(spelling, matches);
        }
    }
    return output
        .split("\n")
        .filter((line) => /^ {4}.+/.test(line))
        .map((line) => {
            const record = line.slice(4);
            const candidates = [...record.matchAll(/:(\d+):/g)].flatMap((hit) => {
                const spelling = record.slice(0, hit.index);
                const matches = files === undefined ? [spelling] : [...(paths.get(spelling) ?? [])];
                return matches.map((file) => ({ file, line: Number(hit[1]) }));
            });
            return candidates.length === 1 &&
                (files !== undefined || !candidates[0].file.startsWith('"')) &&
                Number.isSafeInteger(candidates[0].line) &&
                candidates[0].line > 0
                ? candidates[0]
                : null;
        });
}

/** `path:line` for every probe hit that falls on a line `diffU0` (`git diff -U0 a..b`) adds. */
export function hitsInAddedLines(probeOutput: string, diffU0: string, files?: readonly string[]): string[] {
    const hits = new Map<string, Set<number>>();

    const parsed = probeHits(probeOutput, files);
    for (const hit of parsed) {
        if (!hit) {
            continue;
        }
        const lines = hits.get(hit.file) ?? new Set<number>();
        lines.add(hit.line);
        hits.set(hit.file, lines);
    }

    const found: string[] = parsed.includes(null) ? ["unparseable probe hit"] : [];
    let file = "";

    for (const line of diffU0.split("\n")) {
        const header = /^\+\+\+ (.+)$/.exec(line);

        if (header) {
            let name = header[1].replace(/\t$/, "");
            if (files) {
                const matches = files.filter((path) => name === "b/" + path || name === quotedPath("b/" + path));
                file = matches.length === 1 ? matches[0] : "";
                if (!file && name !== "/dev/null") {
                    found.push("unparseable diff path");
                }
                continue;
            }
            if (name.startsWith('"')) {
                try {
                    name = SafeJSON.parse(name, { strict: true });
                } catch {
                    found.push("unparseable diff path");
                    continue;
                }
            }
            file = name.startsWith("b/") ? name.slice(2) : "";
            if (!file && name !== "/dev/null") {
                found.push("unparseable diff path");
            }
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
    const probe = Bun.spawnSync(["bash", script, wt], { stdout: "pipe", stderr: "pipe", env: env.getProcessEnv() });
    const out = `${probe.stdout.toString()}${probe.stderr.toString()}`;

    if (probe.exitCode === 0) {
        console.log("✔ personal-data probe: no hit");
        return true;
    }

    const older = probeHits(out).length;

    if (probe.exitCode !== 1 || older === 0) {
        console.log(`✖ personal-data probe exit ${probe.exitCode} with no hit list: it checked nothing`);
        return false;
    }

    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "--cached"], {
        cwd: wt,
        stdout: "pipe",
        stderr: "pipe",
        env: env.getProcessEnv(),
    });
    if (tracked.exitCode !== 0) {
        console.log("✖ personal-data probe: cannot associate hits with tracked filenames");
        return false;
    }
    const files = [...new Set(tracked.stdout.toString().split("\0").filter(Boolean))];
    const diff = Bun.spawnSync(
        [
            "git",
            "-c",
            "core.quotePath=true",
            "diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--text",
            "--no-renames",
            "-U0",
            `${from}..${to}`,
        ],
        {
            cwd: wt,
            stdout: "pipe",
            stderr: "pipe",
            env: env.getProcessEnv(),
        }
    );

    if (diff.exitCode !== 0) {
        console.log(`✖ git diff ${from}..${to} failed: ${diff.stderr.toString().slice(0, 200)}`);
        return false;
    }

    const added = hitsInAddedLines(out, diff.stdout.toString(), files);

    if (added.length > 0) {
        console.log(`✖ personal-data probe: ${added.length} hit(s) in lines this push adds: ${added.join(", ")}`);
        return false;
    }

    console.log(`✔ personal-data probe: ${older} older hit(s), none in a line this push adds`);
    return true;
}
