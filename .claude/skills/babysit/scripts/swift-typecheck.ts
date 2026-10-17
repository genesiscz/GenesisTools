#!/usr/bin/env bun
/**
 * Typecheck a SwiftPM package with `swiftc` alone: every library and executable target emits its module, and test
 * targets are typechecked against those fresh modules. No binary is produced or launched, so it works while syspolicyd is stuck (a
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

interface TargetDependency {
    name: string;
    local: boolean;
}

interface Target {
    kind: "target" | "executableTarget" | "testTarget";
    name: string;
    path: string;
    resources: boolean;
    dependencies: TargetDependency[];
}

export function swiftCompilerCommand(options: { pkg: string; triple: string; args: string[] }): string[] {
    const identity = basename(resolve(options.pkg))
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_");
    return ["xcrun", "swiftc", "-target", options.triple, "-package-name", identity, ...options.args];
}

export function parseSwiftTargets(manifest: string): Target[] {
    function closing(text: string, start: number): number {
        const end = text[start] === "(" ? ")" : "]";
        let depth = 1;
        let quoted = false;
        for (let i = start + 1; i < text.length; i++) {
            if (quoted && text[i] === "\\") {
                i++;
                continue;
            }
            if (text[i] === '"') {
                quoted = !quoted;
            }
            if (quoted) {
                continue;
            }
            if (text.slice(i, i + 2) === "//") {
                const newline = text.indexOf("\n", i + 2);
                i = newline < 0 ? text.length : newline;
                continue;
            }
            if (text[i] === text[start]) {
                depth++;
            } else if (text[i] === end && --depth === 0) {
                return i;
            }
        }
        throw new Error("unclosed Swift target declaration");
    }

    function dependencies(body: string): TargetDependency[] {
        const declaration = /\bdependencies\s*:\s*\[/.exec(body);
        if (!declaration) {
            return [];
        }
        const start = declaration.index + declaration[0].length - 1;
        const text = body.slice(start + 1, closing(body, start));
        const names: TargetDependency[] = [];
        for (let i = 0; i < text.length; ) {
            const rest = text.slice(i);
            const skip = /^(?:[\s,]+|\/\/[^\n]*(?:\n|$))/.exec(rest);
            if (skip) {
                i += skip[0].length;
                continue;
            }
            const literal = /^"([^"]+)"/.exec(rest);
            if (literal) {
                names.push({ name: literal[1], local: false });
                i += literal[0].length;
                continue;
            }
            const call = /^\.(target|byName|product)\s*\(/.exec(rest);
            if (!call) {
                throw new Error("unsupported Swift target dependency: " + rest.slice(0, 80));
            }
            const open = i + call[0].length - 1;
            const end = closing(text, open);
            const name = /\bname\s*:\s*"([^"]+)"/.exec(text.slice(open + 1, end));
            if (!name) {
                throw new Error("Swift target dependency has no name");
            }
            if (call[1] !== "product") {
                names.push({ name: name[1], local: call[1] === "target" });
            }
            i = end + 1;
        }
        return names;
    }

    function targets(): Target[] {
        const found: Target[] = [];
        const re = /\.(target|executableTarget|testTarget)\s*\(\s*name:\s*"([^"]+)"/g;

        for (let m = re.exec(manifest); m; m = re.exec(manifest)) {
            const kind = m[1] as Target["kind"];
            const end = closing(manifest, manifest.indexOf("(", m.index));
            const body = manifest.slice(m.index + m[0].length, end);
            re.lastIndex = end + 1;
            const path = /path:\s*"([^"]+)"/.exec(body)?.[1] ?? join(kind === "testTarget" ? "Tests" : "Sources", m[2]);
            found.push({
                kind,
                name: m[2],
                path,
                resources: /resources:/.test(body),
                dependencies: dependencies(body),
            });
        }

        const byName = new Map(found.map((target) => [target.name, target]));
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const ordered: Target[] = [];
        const visit = (name: string) => {
            const target = byName.get(name);
            if (!target) {
                throw new Error("unknown local dependency: " + name);
            }
            if (visiting.has(name)) {
                throw new Error("Swift target dependency cycle: " + name);
            }
            if (visited.has(name)) {
                return;
            }
            visiting.add(name);
            for (const dependency of target.dependencies) {
                if (byName.has(dependency.name)) {
                    visit(dependency.name);
                } else if (dependency.local) {
                    throw new Error("unknown local dependency: " + dependency.name);
                }
            }
            visiting.delete(name);
            visited.add(name);
            ordered.push(target);
        };
        found.forEach((target) => {
            visit(target.name);
        });
        return ordered;
    }

    return targets();
}

export function typecheckPackage(): number {
    const pkg = resolve(flag("--package") ?? ".");
    const manifest = readFileSync(join(pkg, "Package.swift"), "utf8");
    const orderedTargets = parseSwiftTargets(manifest);
    if (orderedTargets.length === 0) {
        console.error("swift-typecheck: no supported targets found in Package.swift; no sources were checked");
        return 1;
    }
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

    for (const target of orderedTargets) {
        const files = swiftFiles(target.path);
        const started = performance.now();
        const result =
            target.kind !== "testTarget"
                ? swiftc([
                      "-emit-module",
                      ...(target.kind === "target" || !files.some((file) => basename(file) === "main.swift")
                          ? ["-parse-as-library"]
                          : []),
                      "-enable-testing",
                      "-module-name",
                      target.name.replaceAll("-", "_"),
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
