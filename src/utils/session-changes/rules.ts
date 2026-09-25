import { homedir, tmpdir } from "node:os";
import { basename, extname, relative, resolve } from "node:path";
import type { ExclusionReason } from "./types";

export interface PathRuleContext {
    /** The session's working directories and the repositories they sit in. */
    roots: string[];
    home?: string;
    /** Temporary directories; `defaultTempDirs()` when unset. */
    tempDirs?: string[];
    /** The turn ran a package install, so a lockfile change is its own. */
    turnInstalls?: boolean;
    /** The command asked a test runner to rewrite snapshots. */
    snapshotsAllowed?: boolean;
}

const BUILD_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    ".build",
    "target",
    "DerivedData",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".swiftpm",
    ".gradle",
]);
const BUILD_EXTENSIONS = new Set([".o", ".a", ".dylib", ".so", ".dll", ".exe", ".class", ".pyc", ".pyo", ".obj"]);
const CACHE_DIRS = new Set([
    ".cache",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".turbo",
    ".parcel-cache",
    ".eslintcache",
    ".vite",
]);
const CACHE_NAMES = new Set([".eslintcache", ".DS_Store", ".stylelintcache", ".prettiercache"]);
const TEST_DIRS = new Set(["coverage", ".nyc_output", "test-results", "playwright-report", "allure-results"]);
const TEST_NAMES = new Set(["junit.xml", "test-results.xml", "lcov.info", "test-report.xml"]);
const LOG_DIRS = new Set(["logs", "log"]);
const LOCKFILES = new Set([
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "composer.lock",
    "Podfile.lock",
    "Package.resolved",
    "go.sum",
    "Gemfile.lock",
]);

function normalize(path: string): string {
    return path.replace(/\\/g, "/");
}

function under(path: string, dir: string): boolean {
    const base = normalize(dir).replace(/\/+$/, "");
    return path === base || path.startsWith(`${base}/`);
}

/** The OS temp dir plus the usual macOS and Linux ones (`/private/...` is where macOS resolves them). */
export function defaultTempDirs(): string[] {
    return [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];
}

function isTemp(path: string, ctx: PathRuleContext): boolean {
    return (ctx.tempDirs ?? defaultTempDirs()).some((dir) => under(path, normalize(resolve(dir))));
}

/** The deepest root that contains the path, or null. */
export function rootOf(path: string, roots: readonly string[]): string | null {
    let best: string | null = null;

    for (const root of roots) {
        if (under(path, root) && (best === null || root.length > best.length)) {
            best = normalize(root);
        }
    }

    return best;
}

function isAppBundle(path: string, home: string): boolean {
    return /\.app\/Contents(?:\/|$)/.test(path) || under(path, "/Applications") || under(path, `${home}/Applications`);
}

function isCache(path: string, home: string): boolean {
    const homeCaches = [
        ".genesis-tools",
        "Library/Caches",
        ".cache",
        ".bun",
        ".npm",
        ".cargo/registry",
        ".gradle/caches",
    ];

    if (homeCaches.some((dir) => under(path, `${home}/${dir}`))) {
        return true;
    }

    return CACHE_NAMES.has(basename(path)) || extname(path) === ".tsbuildinfo";
}

/**
 * Why a change at `path` is automatic rather than the session's own work, or null when it may
 * be. Directory names are tested on the path RELATIVE to its root: a checkout that lives under
 * `~/build/app` must not have every file read as build output.
 */
export function pathExclusion(path: string, ctx: PathRuleContext): ExclusionReason | null {
    const file = normalize(path);
    const home = normalize(ctx.home ?? homedir());

    if (isAppBundle(file, home)) {
        return "app-bundle";
    }

    if (isTemp(file, ctx)) {
        return "temp-dir";
    }

    if (isCache(file, home)) {
        return "cache";
    }

    if (/(?:^|\/)\.git\//.test(file)) {
        return "git-metadata";
    }

    const root = rootOf(file, ctx.roots);

    if (root === null) {
        return "outside-cwd";
    }

    const parts = normalize(relative(root, file)).split("/");
    const dirs = parts.slice(0, -1);
    const name = parts.at(-1) ?? "";
    const extension = extname(name).toLowerCase();

    if (dirs.some((dir) => CACHE_DIRS.has(dir))) {
        return "cache";
    }

    if (dirs.some((dir) => BUILD_DIRS.has(dir)) || BUILD_DIRS.has(name) || BUILD_EXTENSIONS.has(extension)) {
        return "build-output";
    }

    const snapshot = dirs.includes("__snapshots__") || extension === ".snap";

    if (dirs.some((dir) => TEST_DIRS.has(dir)) || TEST_NAMES.has(name) || (snapshot && !ctx.snapshotsAllowed)) {
        return "test-output";
    }

    if (extension === ".log" || /\.log\.\d+$/.test(name) || dirs.some((dir) => LOG_DIRS.has(dir))) {
        return "log-file";
    }

    if (LOCKFILES.has(name) && !ctx.turnInstalls) {
        return "lockfile-churn";
    }

    return null;
}
