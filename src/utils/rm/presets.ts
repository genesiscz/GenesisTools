import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { RmConfig, RmPreset } from "./config";
import { canonicalPath, isInside, realOrSelf } from "./paths";

const JS_MARKERS = ["package.json"];
const GRADLE_MARKERS = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

/** Folders a build or an install recreates, each tied to the file that proves which tool made it. */
export const BUILTIN_PRESETS: readonly RmPreset[] = [
    {
        id: "node_modules",
        description: "installed JavaScript packages (bun install / npm install recreates them)",
        names: ["node_modules"],
        markers: JS_MARKERS,
    },
    {
        id: "js-build",
        description: "JavaScript build output and tool caches next to a package.json",
        names: [
            "dist",
            "build",
            "out",
            "coverage",
            ".next",
            ".nuxt",
            ".output",
            ".turbo",
            ".parcel-cache",
            ".svelte-kit",
            ".vite",
            "storybook-static",
        ],
        markers: JS_MARKERS,
    },
    {
        id: "node-cache",
        description: "the .cache folder tools keep inside node_modules",
        names: [".cache"],
        parentNames: ["node_modules"],
    },
    {
        id: "swiftpm",
        description: "SwiftPM build folders next to a Package.swift",
        names: [".build"],
        markers: ["Package.swift"],
    },
    {
        id: "xcode-derived-data",
        description: "each project's folder in Xcode's DerivedData",
        names: [],
        within: join(homedir(), "Library", "Developer", "Xcode", "DerivedData"),
    },
    {
        id: "cocoapods",
        description: "installed CocoaPods next to a Podfile",
        names: ["Pods"],
        markers: ["Podfile"],
    },
    { id: "rust", description: "Cargo build output next to a Cargo.toml", names: ["target"], markers: ["Cargo.toml"] },
    {
        id: "gradle",
        description: "Gradle and Android native build output",
        names: ["build", ".gradle", ".cxx", ".externalNativeBuild"],
        markers: GRADLE_MARKERS,
    },
    {
        id: "python",
        description: "Python bytecode and tool caches",
        names: ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox"],
    },
    {
        id: "cmake",
        description: "CMake build folders next to a CMakeLists.txt",
        names: ["cmake-build-*"],
        markers: ["CMakeLists.txt"],
    },
    {
        id: "zig",
        description: "Zig build output next to a build.zig",
        names: [".zig-cache", "zig-out"],
        markers: ["build.zig"],
    },
    {
        id: "dotnet",
        description: ".NET build output next to a project file",
        names: ["bin", "obj"],
        markers: ["*.csproj", "*.fsproj", "*.vbproj"],
    },
];

export function presetsFor(config: Pick<RmConfig, "disabledPresets" | "customPresets">): RmPreset[] {
    const disabled = new Set(config.disabledPresets);
    return [...BUILTIN_PRESETS, ...config.customPresets].filter((preset) => !disabled.has(preset.id));
}

function globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
}

function matchesName(name: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => (pattern.includes("*") ? globToRegExp(pattern).test(name) : pattern === name));
}

/** The first preset `path` (a folder) satisfies, or null. `siblings` lists the parent folder, for markers. */
export function matchPreset(path: string, presets: readonly RmPreset[], siblings?: readonly string[]): RmPreset | null {
    const name = basename(path);
    const parent = dirname(path);
    let parentEntries = siblings;

    for (const preset of presets) {
        if (preset.within) {
            if (dirname(canonicalPath(path)) === realOrSelf(preset.within)) {
                return preset;
            }

            continue;
        }

        if (!matchesName(name, preset.names)) {
            continue;
        }

        if (preset.parentNames && !matchesName(basename(parent), preset.parentNames)) {
            continue;
        }

        if (preset.markers && preset.markers.length > 0) {
            parentEntries ??= listNames(parent);
            const markers = preset.markers;

            if (!parentEntries.some((entry) => matchesName(entry, markers))) {
                continue;
            }
        }

        return preset;
    }

    return null;
}

function listNames(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch (error) {
        logger.debug({ dir, error }, "rm: cannot list a folder for preset markers");
        return [];
    }
}

/**
 * Folders never entered while scanning, matched or not: version control metadata, and build or package trees whose
 * own `build/`, `dist/` and `.cxx/` folders belong to a dependency (jest and webpack ship a `build/` inside
 * node_modules). A match is not entered either, so a nested copy is never listed twice.
 */
const SCAN_SKIP = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".pnpm",
    ".cache",
    ".turbo",
    ".next",
    "dist",
    ".build",
    "DerivedData",
    "Pods",
    ".gradle",
    ".trash",
]);

export interface PresetMatch {
    path: string;
    preset: RmPreset;
}

/**
 * Every folder under `root` (up to `maxDepth` levels) that one of `presets` matches. Symlinks are not followed,
 * a match is not entered, and `node_modules` is entered only for its own `.cache`.
 */
export function scanPresets(root: string, presets: readonly RmPreset[], maxDepth = 8): PresetMatch[] {
    const found: PresetMatch[] = [];
    const withinPresets = presets.filter((preset) => preset.within);

    for (const preset of withinPresets) {
        const within = preset.within ?? "";

        if (!isInside(within, root) && within !== root && !isInside(root, within)) {
            continue;
        }

        for (const entry of readDir(within)) {
            if (entry.isDirectory()) {
                found.push({ path: join(within, entry.name), preset });
            }
        }
    }

    const walk = (dir: string, depth: number): void => {
        const entries = readDir(dir);
        const names = entries.map((entry) => entry.name);

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const full = join(dir, entry.name);
            const preset = matchPreset(full, presets, names);

            if (preset && !preset.within) {
                found.push({ path: full, preset });
                continue;
            }

            if (entry.name === "node_modules") {
                const cache = join(full, ".cache");
                const cachePreset = matchPreset(cache, presets, [".cache"]);

                if (cachePreset && readDir(full).some((e) => e.name === ".cache" && e.isDirectory())) {
                    found.push({ path: cache, preset: cachePreset });
                }

                continue;
            }

            if (SCAN_SKIP.has(entry.name) || depth >= maxDepth) {
                continue;
            }

            walk(full, depth + 1);
        }
    };

    walk(root, 1);
    return found;
}

function readDir(dir: string): Dirent[] {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        logger.debug({ dir, error }, "rm: cannot read a folder while scanning presets");
        return [];
    }
}
