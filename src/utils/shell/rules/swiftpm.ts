// `swift build`, `swift test` or `swift run` in a package that has a local path
// dependency, without `--disable-build-manifest-caching`.
//
// SwiftPM re-plans a build only when the ROOT package's own target folders,
// Package.swift or Package.resolved change (its `PackageStructure` node watches
// nothing else). A Swift file added to a local path dependency
// (`.package(path: "../GenesisKit")`) changes none of those, so the cached plan
// keeps the dependency's old file list: the new file is never compiled, and the
// first use of its symbol fails with "cannot find 'X' in scope" on correct code.
// The flag re-plans every time; on GenesisTools' app package that costs 0.1 s.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { commandTokenIndex, commandWord, originalSlice, rawToken, splitPipeline, tokenize } from "../scan";
import type { ShellMatch, ShellRule } from "./types";

const FLAG = "--disable-build-manifest-caching";
const BUILDING = new Set(["build", "test", "run"]);
// `.package(path: "../Kit")` or `.package(name: "Kit", path: "../Kit")`.
const LOCAL_DEPENDENCY = /\.package\(\s*(?:name:\s*"[^"]*"\s*,\s*)?path:/;

// A folder argument as the shell would read it, against `base`. Null when it
// holds an expansion the guard cannot know (`$dir`, `$(…)`, `-`).
function resolveFolder(argument: string, base: string): string | null {
    const home = argument.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());

    if (home === "-" || home.includes("$") || home.includes("`")) {
        return null;
    }

    return isAbsolute(home) ? home : resolve(base, home);
}

// Whether the package in `folder` declares a local path dependency. A folder with no
// manifest has none; an unreadable one throws, and the registry skips the rule.
function hasLocalDependency(folder: string): boolean {
    const manifest = join(folder, "Package.swift");

    if (!existsSync(manifest)) {
        return false;
    }

    return LOCAL_DEPENDENCY.test(readFileSync(manifest, "utf8"));
}

// The `--package-path` value (`--package-path X` or `--package-path=X`), or null.
function packagePathArgument(args: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--package-path") {
            return args[i + 1] ?? null;
        }

        if (args[i].startsWith("--package-path=")) {
            return args[i].slice("--package-path=".length);
        }
    }

    return null;
}

export const swiftpmStalePlan: ShellRule = {
    id: "swiftpm-stale-plan",
    kind: "misread",
    title: "swift build/test/run of a package with a local path dependency, without --disable-build-manifest-caching",
    severity: "block",
    why:
        "SwiftPM re-plans a build only when the root package's own folders, Package.swift or Package.resolved " +
        "change. A Swift file added to a local path dependency changes none of them, so the cached plan keeps the " +
        "dependency's old file list: the new file is never compiled and its first use fails with \"cannot find 'X' " +
        'in scope" on correct code, which reads as a real compile error. --disable-build-manifest-caching re-plans ' +
        "every time and costs about 0.1 s.",
    // Relative to the repository root, which the registry test passes as the working folder.
    wrong: "swift test --package-path src/macos/GenesisTools",
    right: "swift test --package-path src/macos/GenesisTools --disable-build-manifest-caching",
    evidence:
        'Three merges that added files to a local path dependency failed an app build with "cannot find type" and ' +
        "passed on the second run. A preview target failed twice with \"cannot find 'X' in scope\" because its " +
        'build plan, one minute older than the new file, was reused without "Planning build". Reproduced with a ' +
        "two-package fixture: the new dependency file is not compiled until the flag is passed. About one Swift " +
        "package in six in a sampled projects folder has a local path dependency.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            // `cd` moves the folder for the statements after it in the same list.
            let folder: string | null = scan.cwd ?? process.cwd();

            for (const statement of statements) {
                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens);

                    if (cmd === -1) {
                        continue;
                    }

                    const word = commandWord(tokens[cmd].text);
                    const args = tokens.slice(cmd + 1).map((token) => rawToken(scan.command, token));

                    if (word === "cd") {
                        folder = folder && args[0] ? resolveFolder(args[0], folder) : null;
                        continue;
                    }

                    if (word !== "swift" || !BUILDING.has(args[0] ?? "") || args.includes(FLAG)) {
                        continue;
                    }

                    // `--show-bin-path` prints a folder and builds nothing.
                    if (args.includes("--show-bin-path") || !folder) {
                        continue;
                    }

                    const packagePath = packagePathArgument(args);
                    const packageFolder = packagePath === null ? folder : resolveFolder(packagePath, folder);

                    if (!packageFolder || !hasLocalDependency(packageFolder)) {
                        continue;
                    }

                    const subcommand = tokens[cmd + 1];

                    if (!subcommand) {
                        continue;
                    }

                    const insertAt = subcommand.start + subcommand.text.length;
                    const matched = originalSlice(scan, tokens[cmd].start, element.start + element.text.length);
                    const suggestion = `${scan.command.slice(0, insertAt)} ${FLAG}${scan.command.slice(insertAt)}`;

                    return { matched, index: tokens[cmd].start, suggestion };
                }
            }
        }

        return null;
    },
};

export const swiftpmRules: readonly ShellRule[] = [swiftpmStalePlan];
