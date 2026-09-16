import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Finding, GraphNode, MeasuredModule, SideEffect, SideEffectKind } from "./types";

/** Package manifest fields that mark a native addon. */
const NATIVE_MANIFEST_KEYS = ["binary", "gypfile", "napi"];
const NATIVE_DEPENDENCY = /^(@napi-rs\/|node-gyp-build|node-addon-api|bindings|prebuild-install|node-pre-gyp)/;
const PLATFORM_SUFFIX = /-(darwin|linux|win32|android|freebsd)-(arm64|x64|ia32|arm)/;
const NATIVE_SOURCE = /\.node["']|node-gyp-build|bun:ffi|process\.dlopen|\bdlopen\(|\bnapi\b/;
const SNIFF_BYTES = 64 * 1024;

export interface AttributeOptions {
    node: GraphNode;
    measured: MeasuredModule;
    /** Self time at or above which a module is worth explaining. */
    slowMs: number;
    /** Total time at or above which a subtree counts as large. */
    largeSubtreeMs: number;
}

interface PackageManifest {
    binary?: unknown;
    gypfile?: unknown;
    napi?: unknown;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

function readHead(file: string): string {
    try {
        const fd = openSync(file, "r");
        const buffer = Buffer.alloc(SNIFF_BYTES);

        try {
            const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
            return buffer.toString("utf8", 0, read);
        } finally {
            closeSync(fd);
        }
    } catch (error) {
        logger.debug({ file, error }, "ts: could not sniff module head");
        return "";
    }
}

function findManifest(file: string): { dir: string; manifest: PackageManifest } | undefined {
    let dir = dirname(file);

    while (dir.includes(`${sep}node_modules${sep}`) || basename(dirname(dir)) === "node_modules") {
        const candidate = join(dir, "package.json");

        if (existsSync(candidate)) {
            try {
                const manifest: PackageManifest = SafeJSON.parse(readFileSync(candidate, "utf8"));
                return { dir, manifest };
            } catch (error) {
                logger.debug({ candidate, error }, "ts: unreadable package.json");
                return undefined;
            }
        }

        const parent = dirname(dir);

        if (parent === dir) {
            break;
        }

        dir = parent;
    }

    return undefined;
}

/** Why this module might be loading machine code. Empty when nothing points that way. */
export function nativeSignals(node: GraphNode): string[] {
    const signals: string[] = [];

    if (node.path.endsWith(".node")) {
        signals.push("the module is a compiled .node addon");
        return signals;
    }

    if (node.kind === "package") {
        const found = findManifest(node.path);

        if (found) {
            for (const key of NATIVE_MANIFEST_KEYS) {
                if (key in found.manifest) {
                    signals.push(`package.json declares "${key}"`);
                }
            }

            const deps = { ...found.manifest.dependencies, ...found.manifest.optionalDependencies };
            const nativeDeps = Object.keys(deps).filter((name) => NATIVE_DEPENDENCY.test(name));
            const platformDeps = Object.keys(deps).filter((name) => PLATFORM_SUFFIX.test(name));

            if (nativeDeps.length > 0) {
                signals.push(`depends on ${nativeDeps.slice(0, 3).join(", ")}`);
            }

            if (platformDeps.length > 0) {
                signals.push(`${platformDeps.length} per-platform binary packages (${platformDeps[0]}, …)`);
            }
        }
    }

    const head = readHead(node.path);
    const match = NATIVE_SOURCE.exec(head);

    if (match) {
        signals.push(`source mentions ${match[0].replace(/["']$/, "")}`);
    }

    return signals;
}

const SIDE_EFFECT_PRIORITY: SideEffectKind[] = [
    "await",
    "native",
    "spawn",
    "db",
    "network",
    "fs",
    "timer",
    "hook",
    "construct",
    "call",
    "assign",
];

const SIDE_EFFECT_LABEL: Record<SideEffectKind, string> = {
    await: "top-level await",
    native: "native load",
    spawn: "child process",
    db: "database open",
    network: "network",
    fs: "file system",
    timer: "timer",
    hook: "process hook",
    construct: "constructor call",
    call: "call",
    assign: "assignment",
};

function rankSideEffects(effects: SideEffect[]): SideEffect[] {
    return [...effects].sort(
        (a, b) => SIDE_EFFECT_PRIORITY.indexOf(a.kind) - SIDE_EFFECT_PRIORITY.indexOf(b.kind) || a.line - b.line
    );
}

/** Is this file mostly `export … from` lines? */
export function isBarrel(node: GraphNode): boolean {
    const parsed = node.parsed;

    if (!parsed) {
        return false;
    }

    const runtimeReexports = parsed.reexports.filter((site) => !site.typeOnly).length;

    if (runtimeReexports < 2) {
        return false;
    }

    const indexFile = /^index\.[cm]?[jt]sx?$/.test(basename(node.path));
    return parsed.localExports <= 1 || (indexFile && parsed.localExports <= 2);
}

/**
 * Explain a module's cost from what the parser and the manifest can see. Findings are ordered
 * by how directly they explain the time: a native load first, then module-scope work, then
 * shape (subtree size, barrel). A cheap module still gets structural findings, so `barrels` and
 * `lazy` can reuse them, but only slow ones get the "large subtree" line.
 */
export function attribute(options: AttributeOptions): Finding[] {
    const { node, measured } = options;
    const findings: Finding[] = [];
    const anchor = (line: number) => `${node.label}:${line}`;

    if (measured.importError) {
        const exited = measured.importError.startsWith("exit ");
        findings.push({
            kind: exited ? "exits-on-import" : "import-error",
            severity: exited ? "medium" : "high",
            summary: exited
                ? `calls process.exit(${measured.importError.slice(5)}) while being imported: a CLI entrypoint that parses argv at module scope`
                : `import rejected: ${measured.importError}`,
            details: [],
        });
    }

    if (measured.cycle) {
        const carrier = measured.cycle.paidBy === node.label;
        findings.push({
            kind: "cycle",
            severity: carrier ? "medium" : "low",
            summary: carrier
                ? `first member imported of a ${measured.cycle.size}-module import cycle: its self time is the whole cycle's`
                : `member of a ${measured.cycle.size}-module import cycle; its evaluation was paid by ${measured.cycle.paidBy}`,
            details: [],
        });
    }

    const native = nativeSignals(node);

    if (native.length > 0) {
        findings.push({
            kind: "native-addon",
            severity: "high",
            summary: "loads a native addon (dlopen of machine code, paid on every start)",
            details: native,
            ms: measured.selfMs,
        });
    }

    const parsed = node.parsed;

    if (parsed) {
        const awaits = parsed.sideEffects.filter((effect) => effect.kind === "await");

        if (awaits.length > 0) {
            findings.push({
                kind: "top-level-await",
                severity: "high",
                summary: `${awaits.length} top-level await${awaits.length === 1 ? "" : "s"}: every importer waits for it`,
                details: awaits.slice(0, 4).map((effect) => `${anchor(effect.line)}  ${effect.text}`),
            });
        }

        const work = rankSideEffects(parsed.sideEffects.filter((effect) => effect.kind !== "await"));
        const notable = work.filter((effect) => effect.kind !== "call" && effect.kind !== "assign");
        const shown = notable.length > 0 ? notable : work;

        if (shown.length > 0 && (measured.selfMs >= options.slowMs || notable.length > 0)) {
            const kinds = [...new Set(shown.map((effect) => SIDE_EFFECT_LABEL[effect.kind]))];
            findings.push({
                kind: "side-effects",
                severity: notable.length > 0 ? "medium" : "low",
                summary: `${work.length} statement${work.length === 1 ? "" : "s"} run at module scope (${kinds.slice(0, 3).join(", ")})`,
                details: shown.slice(0, 5).map((effect) => `${anchor(effect.line)}  ${effect.text}`),
            });
        }

        if (isBarrel(node)) {
            const runtime = parsed.reexports.filter((site) => !site.typeOnly);
            findings.push({
                kind: "barrel",
                severity: "low",
                summary: `barrel: re-exports ${runtime.length} modules; a caller pays for all of them however few names it uses`,
                details: [],
                ms: measured.totalMs - measured.selfMs,
            });
        }
    }

    if (measured.totalMs >= options.largeSubtreeMs && measured.descendants >= 5) {
        findings.push({
            kind: "large-subtree",
            severity: measured.totalMs >= options.largeSubtreeMs * 4 ? "medium" : "low",
            summary: `pulls ${measured.descendants} modules (${measured.totalMs.toFixed(1)} ms in total, ${measured.selfMs.toFixed(1)} ms of it its own)`,
            details: [],
            ms: measured.totalMs - measured.selfMs,
        });
    }

    return findings;
}
