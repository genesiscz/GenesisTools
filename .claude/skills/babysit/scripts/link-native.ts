#!/usr/bin/env bun
/**
 * Point each native file (Mach-O executable, .node, .dylib) in a worktree's node_modules at the main checkout's
 * byte-identical twin with a symlink. On 2026-10-14 syspolicyd sat at 100% CPU and blocked the first exec or dlopen
 * of every NEW native file, so a fresh worktree's tsgo, biome and native add-ons hung at _dyld_start; the main
 * checkout's copies had been assessed before and ran at once. Harmless when syspolicyd is healthy.
 *
 *   bun link-native.ts --main <checkout> <worktree> [...]
 */
import { lstatSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const MACHO_MAGIC = new Set(["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"]);

function isNative(path: string, mode: number, size: number): boolean {
    if (!(mode & 0o111) && !/\.(node|dylib|so)$/.test(path)) {
        return false;
    }

    if (size <= 4096) {
        return false;
    }

    try {
        return MACHO_MAGIC.has(readFileSync(path).subarray(0, 4).toString("hex"));
    } catch {
        return false;
    }
}

export function linkNativeFiles(options: { worktree: string; main: string }): { linked: number; differ: number } {
    const worktree = resolve(options.worktree);
    const main = resolve(options.main);
    let linked = 0;
    let differ = 0;
    const stack = [join(worktree, "node_modules")];

    while (stack.length) {
        const dir = stack.pop() as string;
        let names: string[] = [];

        try {
            names = readdirSync(dir);
        } catch {
            continue;
        }

        for (const name of names) {
            const path = join(dir, name);
            const st = lstatSync(path);

            if (st.isSymbolicLink()) {
                continue;
            }

            if (st.isDirectory()) {
                stack.push(path);
                continue;
            }

            if (!st.isFile() || !isNative(path, st.mode, st.size)) {
                continue;
            }

            const twin = join(main, relative(worktree, path));

            try {
                if (!readFileSync(twin).equals(readFileSync(path))) {
                    differ++;
                    continue;
                }
            } catch {
                differ++;
                continue;
            }

            rmSync(path);
            symlinkSync(twin, path);
            linked++;
        }
    }

    return { linked, differ };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const mainIndex = args.indexOf("--main");

    if (mainIndex < 0 || !args[mainIndex + 1]) {
        console.error("usage: link-native.ts --main <checkout> <worktree> [...]");
        process.exit(2);
    }

    const main = args[mainIndex + 1];

    for (const worktree of args.filter((_, i) => i !== mainIndex && i !== mainIndex + 1)) {
        const { linked, differ } = linkNativeFiles({ worktree, main });
        console.log(
            `${worktree}: linked ${linked} native files to the main checkout, ${differ} differ or have no twin`
        );
    }
}
