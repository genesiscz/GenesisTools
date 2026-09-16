// Deterministic APFS clone fixtures. The same trees back the engine tests and
// the `du bench` / `macos clones` benchmarks, so a number that regresses in a
// test is the number the benchmark would have shown.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BLK = 4096;

export interface CloneFixture {
    root: string;
    /** Many small odd-sized files, no clones anywhere. Every byte of "shared" reported here is a bug. */
    noClones: { dir: string; files: number; logicalBytes: number };
    /** One base file plus N `clonefile(2)` copies. */
    realClones: { dir: string; baseBytes: number; clones: number };
    /** Worktree shape: a base tree cloned K times, then one file per copy rewritten privately (a postinstall). */
    worktrees: { dir: string; copies: number; filesPerTree: number; fileBytes: number; rewrittenPerCopy: number };
}

/** Small linear congruential generator so sizes are stable across runs and machines. */
function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        return x / 0x1_0000_0000;
    };
}

function cloneFile(src: string, dst: string): void {
    execFileSync("cp", ["-c", src, dst], { stdio: "pipe" });
}

export function makeCloneFixture(
    root: string,
    opts: { files?: number; clones?: number; copies?: number; filesPerTree?: number; fileBytes?: number } = {}
): CloneFixture {
    const files = opts.files ?? 400;
    const clones = opts.clones ?? 5;
    const copies = opts.copies ?? 3;
    const filesPerTree = opts.filesPerTree ?? 12;
    const fileBytes = opts.fileBytes ?? 256 * 1024;
    const rnd = lcg(0x5eed);

    // A — no clones, odd sizes so every file carries tail-block slack.
    const a = join(root, "a-noclones");
    mkdirSync(a, { recursive: true });
    let logical = 0;
    for (let i = 0; i < files; i++) {
        const n = 100 + Math.floor(rnd() * 9000);
        const buf = Buffer.alloc(n);
        for (let k = 0; k < n; k++) {
            buf[k] = (i * 31 + k * 7) & 0xff;
        }

        writeFileSync(join(a, `f${i}.bin`), buf);
        logical += n;
    }

    // B — one base, N real clones.
    const b = join(root, "b-realclones");
    mkdirSync(b, { recursive: true });
    const baseBytes = 4 * 1024 * 1024;
    writeFileSync(join(b, "base.bin"), Buffer.alloc(baseBytes, 0x58));
    for (let i = 1; i <= clones; i++) {
        cloneFile(join(b, "base.bin"), join(b, `clone${i}.bin`));
    }

    // C — worktrees: base tree, K clone copies, one private rewrite per copy.
    const c = join(root, "c-worktrees");
    const base = join(c, "base", "node_modules");
    mkdirSync(base, { recursive: true });
    for (let i = 0; i < filesPerTree; i++) {
        writeFileSync(join(base, `pkg${i}.bin`), Buffer.alloc(fileBytes, i & 0xff));
    }

    for (let k = 1; k <= copies; k++) {
        const wt = join(c, `wt${k}`, "node_modules");
        mkdirSync(join(c, `wt${k}`), { recursive: true });
        execFileSync("cp", ["-Rc", base, wt], { stdio: "pipe" });
        // A postinstall that rewrites in place: the copy stops sharing that file.
        writeFileSync(join(wt, "pkg0.bin"), Buffer.alloc(fileBytes, 0xa0 + k));
    }

    return {
        root,
        noClones: { dir: a, files, logicalBytes: logical },
        realClones: { dir: b, baseBytes, clones },
        worktrees: { dir: c, copies, filesPerTree, fileBytes, rewrittenPerCopy: 1 },
    };
}
