/**
 * Split the walk cost: how much is `readdirSync` vs `statSync({bigint:true})`?
 * Mimics walkFiles but lets us toggle.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.argv[2] ?? process.cwd();

// Variant 1 — readdir-only (no per-file stat). What the dir-mtime cache helps.
function readdirOnly(root: string): { dirs: number; files: number } {
    let dirs = 0;
    let files = 0;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        dirs += 1;
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) stack.push(join(cur, e.name));
            else if (e.isFile()) files += 1;
        }
    }
    return { dirs, files };
}

// Variant 2 — readdir + stat per file (current walkFiles).
function fullWalk(root: string): { dirs: number; files: number } {
    let dirs = 0;
    let files = 0;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        dirs += 1;
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            const p = join(cur, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile()) {
                try {
                    statSync(p, { bigint: true });
                    files += 1;
                } catch {}
            }
        }
    }
    return { dirs, files };
}

console.log("Root:", root);
// Warm-up both code paths
readdirOnly(root);
fullWalk(root);

// Re-time
const t0 = performance.now();
const r1 = readdirOnly(root);
const t1 = performance.now();
console.log(`readdir-only: dirs=${r1.dirs} files=${r1.files} in ${(t1 - t0).toFixed(0)}ms`);

const t2 = performance.now();
const r2 = fullWalk(root);
const t3 = performance.now();
console.log(`readdir+stat: dirs=${r2.dirs} files=${r2.files} in ${(t3 - t2).toFixed(0)}ms`);

const t4 = performance.now();
const r3 = readdirOnly(root);
const t5 = performance.now();
console.log(`readdir-only #2: ${(t5 - t4).toFixed(0)}ms`);

const t6 = performance.now();
const r4 = fullWalk(root);
const t7 = performance.now();
console.log(`readdir+stat #2: ${(t7 - t6).toFixed(0)}ms`);

const readdirShare = (t5 - t4) / (t7 - t6);
console.log(`readdir-only is ${(readdirShare * 100).toFixed(0)}% of full walk time`);
console.log(`-> stat overhead is ${((1 - readdirShare) * 100).toFixed(0)}% of full walk time`);
console.log(
    `-> if dir-mtime cache skips 90% of readdirs, you save ~${(readdirShare * 0.9 * (t7 - t6)).toFixed(0)}ms of ${(t7 - t6).toFixed(0)}ms walk`
);
