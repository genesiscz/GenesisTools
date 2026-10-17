#!/usr/bin/env bun
/**
 * Typecheck a SwiftPM package with `swiftc` alone: every library target emits its module, every executable and test
 * target is typechecked against them. No binary is produced or launched, so it works while syspolicyd is stuck (a
 * fresh build output or test bundle hangs at its first launch then) and while another session holds the one Swift
 * build slot. It proves the code compiles, not that tests pass: run the tests when a build is allowed.
 *
 *   bun swift-typecheck.ts --package <dir> [--deps <dir with prebuilt .swiftmodule files>] [--out <dir>]
 *
 * External package products are not built here: `--deps` points at a build that has them (default: the package's
 * twin in the main checkout, `<main>/<same relative path>/.build/arm64-apple-macosx/debug/Modules`). Measured
 * 2026-10-14: GenesisKit 113 s plus its tests 23 s; ax-tool and SnapshotSupport in under a minute.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { flag, loadRun } from "./run";

interface Target {
    kind: "target" | "executableTarget" | "testTarget";
    name: string;
    path: string;
    resources: boolean;
}

export function swiftCompilerCommand(options: { pkg: string; triple: string; args: string[] }): string[] {
    const identity = basename(resolve(options.pkg))
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_");
    return ["xcrun", "swiftc", "-target", options.triple, "-package-name", identity, ...options.args];
}

export function typecheckPackage(): number {
    const pkg = resolve(flag("--package") ?? ".");
    const manifest = readFileSync(join(pkg, "Package.swift"), "utf8");
    const version = /\.macOS\(\.v(\d+)(?:_(\d+))?\)/.exec(manifest);
    const triple = `arm64-apple-macos${version ? `${version[1]}${version[2] ? `.${version[2]}` : ""}` : "14"}`;
    const out = resolve(
        flag("--out") ?? join(loadRun().dir, "swift-typecheck", relative("/", pkg).replaceAll("/", "_"))
    );
    const main = loadRun().main;
    const deps =
        flag("--deps") ?? join(main, relative(gitRoot(pkg), pkg), ".build", "arm64-apple-macosx", "debug", "Modules");

    function gitRoot(dir: string): string {
        const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
        return p.stdout.toString().trim() || dir;
    }

    function targets(): Target[] {
        const found: Target[] = [];
        const re = /\.(target|executableTarget|testTarget)\(\s*name:\s*"([^"]+)"/g;

        for (let m = re.exec(manifest); m; m = re.exec(manifest)) {
            const kind = m[1] as Target["kind"];
            // The target's own argument list runs to the next target declaration.
            const rest = manifest.slice(m.index + m[0].length);
            const next = rest.search(/\.(target|executableTarget|testTarget)\(/);
            const body = next >= 0 ? rest.slice(0, next) : rest;
            const path = /path:\s*"([^"]+)"/.exec(body)?.[1] ?? join(kind === "testTarget" ? "Tests" : "Sources", m[2]);
            found.push({ kind, name: m[2], path, resources: /resources:/.test(body) });
        }

        return found;
    }

    function swiftFiles(dir: string): string[] {
        return [...new Bun.Glob("**/*.swift").scanSync({ cwd: join(pkg, dir), absolute: true })].sort();
    }

    function swiftc(args: string[]): { code: number; errors: string[] } {
        const p = Bun.spawnSync(swiftCompilerCommand({ pkg, triple, args }), {
            cwd: pkg,
            stdout: "pipe",
            stderr: "pipe",
        });
        const text = `${p.stdout.toString()}${p.stderr.toString()}`;
        return { code: p.exitCode ?? 1, errors: [...new Set(text.split("\n").filter((l) => /^\S.*error:/.test(l)))] };
    }

    mkdirSync(out, { recursive: true });
    // SwiftPM generates `Bundle.module` for a target with resources; a plain swiftc run needs a stand-in.
    const shim = join(out, "ResourceBundleShim.swift");
    writeFileSync(shim, "import Foundation\nextension Bundle { static var module: Bundle { .main } }\n");
    const platform = Bun.spawnSync(["xcrun", "--show-sdk-platform-path"], { stdout: "pipe" }).stdout.toString().trim();
    const includes = ["-I", out, ...(existsSync(deps) ? ["-I", deps] : [])];
    let failed = 0;

    for (const target of targets()) {
        const files = swiftFiles(target.path);
        const started = performance.now();
        const result =
            target.kind === "target"
                ? swiftc([
                      "-emit-module",
                      "-parse-as-library",
                      "-enable-testing",
                      "-module-name",
                      target.name,
                      "-emit-module-path",
                      join(out, `${target.name}.swiftmodule`),
                      ...includes,
                      ...files,
                      ...(target.resources ? [shim] : []),
                  ])
                : swiftc([
                      "-typecheck",
                      "-module-name",
                      target.name.replaceAll("-", "_"),
                      ...includes,
                      ...(target.kind === "testTarget"
                          ? [
                                "-I",
                                join(platform, "Developer/usr/lib"),
                                "-F",
                                join(platform, "Developer/Library/Frameworks"),
                            ]
                          : []),
                      ...files,
                  ]);
        const seconds = ((performance.now() - started) / 1000).toFixed(0);

        if (result.code === 0) {
            console.log(`✔ ${target.kind} ${target.name}: ${files.length} files, ${seconds} s`);
            continue;
        }

        failed++;
        console.log(`✖ ${target.kind} ${target.name}: ${result.errors.length} error(s), ${seconds} s`);

        for (const error of result.errors.slice(0, 10)) {
            console.log(`    ${error.slice(0, 220)}`);
        }
    }

    return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
    process.exitCode = typecheckPackage();
}
