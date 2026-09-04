import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { liveEbWebView, liveMsTeamsRoot, liveWorkProfile } from "./paths";
import { teamsAppIsUp } from "./process";

const log = logger.scoped("ms-teams").log;

export const AUTH_DIRS = ["Cookies", "Login Data", "Local Storage", "Session Storage", "WebStorage"] as const;

export const TFW_CACHE_DIRS = ["Service Worker", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"] as const;

export const EB_CACHE_DIRS = ["GrShaderCache", "GraphiteDawnCache", "ShaderCache", "component_crx_cache"] as const;

export type MoveSpec = { src: string; destName: string };

export function cacheMovePlan(eb: string, profile: string): MoveSpec[] {
    return [
        ...TFW_CACHE_DIRS.map((name) => ({ src: join(profile, name), destName: `tfw__${name}` })),
        ...EB_CACHE_DIRS.map((name) => ({ src: join(eb, name), destName: `eb__${name}` })),
    ];
}

export function idbMovePlan(indexedDbDir: string, names: string[]): MoveSpec[] {
    return names
        .filter((name) => name.startsWith("https_teams.microsoft.com_"))
        .map((name) => ({ src: join(indexedDbDir, name), destName: name }));
}

export function listDirNames(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir);
}

export function existingMoves(plan: MoveSpec[]): MoveSpec[] {
    return plan.filter((item) => existsSync(item.src));
}

export function classifyBackup(entries: string[]): "cache" | "idb" | "mixed" | "unknown" | "empty" {
    if (entries.length === 0) {
        return "empty";
    }

    const cache = entries.some((name) => name.startsWith("tfw__") || name.startsWith("eb__"));
    const idb = entries.some((name) => name.includes("indexeddb"));

    if (cache && idb) {
        return "mixed";
    }

    if (cache) {
        return "cache";
    }

    if (idb) {
        return "idb";
    }

    return "unknown";
}

export function restorePlan(input: {
    dest: string;
    entries: string[];
    eb: string;
    profile: string;
}): { src: string; dest: string }[] {
    const kind = classifyBackup(input.entries);

    if (kind === "cache") {
        return input.entries.map((name) => {
            if (name.startsWith("tfw__")) {
                return { src: join(input.dest, name), dest: join(input.profile, name.slice("tfw__".length)) };
            }

            if (name.startsWith("eb__")) {
                return { src: join(input.dest, name), dest: join(input.eb, name.slice("eb__".length)) };
            }

            throw new Error(`cache backup has unexpected entry: ${name}`);
        });
    }

    if (kind === "idb") {
        const indexedDb = join(input.profile, "IndexedDB");
        return input.entries.map((name) => ({ src: join(input.dest, name), dest: join(indexedDb, name) }));
    }

    throw new Error(`cannot restore backup kind=${kind}`);
}

/**
 * Teams recreates every directory the repair moved out the moment it is
 * relaunched, and `renameSync` refuses to replace a non-empty directory, so
 * the documented "restore if it looks worse" step would fail exactly when it
 * is wanted. These moves clear each destination first, into a sibling backup
 * keyed by the same entry names, so the regenerated copy stays restorable too.
 */
export function asideMoves(
    plan: { src: string; dest: string }[],
    entries: string[],
    asideDir: string
): { src: string; dest: string }[] {
    return plan.flatMap((move, index) =>
        existsSync(move.dest) ? [{ src: move.dest, dest: join(asideDir, entries[index] ?? basename(move.dest)) }] : []
    );
}

export function applyMoves(moves: { src: string; dest: string }[], dryRun: boolean): string[] {
    const done: string[] = [];

    for (const move of moves) {
        if (dryRun) {
            done.push(`DRY ${move.src} -> ${move.dest}`);
            continue;
        }

        renameSync(move.src, move.dest);
        done.push(`moved ${move.src} -> ${move.dest}`);
    }

    return done;
}

export function destDirFor(kind: "cache" | "idb", ts: number, tmpDir = "/tmp"): string {
    return join(tmpDir, `teams-${kind}-${ts}`);
}

export function listBackups(tmpDir = "/tmp"): string[] {
    if (!existsSync(tmpDir)) {
        return [];
    }

    return readdirSync(tmpDir)
        .filter((name) => name.startsWith("teams-cache-") || name.startsWith("teams-idb-"))
        .map((name) => join(tmpDir, name))
        .sort();
}

export function authStatus(profile: string): { name: string; ok: boolean }[] {
    return AUTH_DIRS.map((name) => ({ name, ok: existsSync(join(profile, name)) }));
}

export function duSh(path: string): string {
    const proc = Bun.spawnSync(["du", "-sh", path], { stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();

    if (proc.exitCode !== 0 && stderr) {
        log.debug({ path, stderr, exitCode: proc.exitCode }, "[ms-teams] du failed");
    }

    const line = stdout.split("\n")[0] ?? "";
    return line.split("\t")[0] || "?";
}

export function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch (err) {
        log.debug({ err, path }, "[ms-teams] isDir");
        return false;
    }
}

export interface RepairMoveResult {
    dest: string;
    lines: string[];
    auth: { name: string; ok: boolean }[];
}

export function runRepairMove(opts: {
    kind: "cache" | "idb";
    root?: string;
    tmpDir?: string;
    ts?: number;
    dryRun?: boolean;
}): RepairMoveResult {
    const dryRun = Boolean(opts.dryRun);
    const root = opts.root ?? liveMsTeamsRoot();
    const eb = liveEbWebViewFromRoot(root);
    const profile = liveWorkProfileFromRoot(root);

    if (!existsSync(profile)) {
        throw new Error(`work profile missing: ${profile}`);
    }

    if (!dryRun && teamsAppIsUp()) {
        throw new Error(
            "ABORT: New Teams is still running (MacOS/MSTeams or WebView or respawn). Run tools ms-teams repair quit. The Core Audio driver MSTeamsAudioDevice.driver is not the app."
        );
    }

    const tmpDir = opts.tmpDir ?? "/tmp";
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const dest = destDirFor(opts.kind, ts, tmpDir);
    let plan: MoveSpec[];

    if (opts.kind === "cache") {
        plan = cacheMovePlan(eb, profile);
    } else {
        const indexedDb = join(profile, "IndexedDB");
        plan = idbMovePlan(indexedDb, listDirNames(indexedDb));

        if (plan.length === 0) {
            throw new Error("No https_teams.microsoft.com_* IndexedDB folders to move.");
        }
    }

    const present = existingMoves(plan);

    if (present.length === 0) {
        throw new Error(`Nothing to move for ${opts.kind}.`);
    }

    if (!dryRun) {
        mkdirSync(dest, { recursive: true });
    }

    const moves = present.map((item) => ({ src: item.src, dest: join(dest, item.destName) }));
    const lines = applyMoves(moves, dryRun);
    log.info({ kind: opts.kind, dest, dryRun, count: moves.length }, "[ms-teams] repair move");
    return { dest, lines, auth: authStatus(profile) };
}

export function runRestore(opts: { dest: string; root?: string; dryRun?: boolean; ts?: number }): {
    kind: string;
    lines: string[];
} {
    const dryRun = Boolean(opts.dryRun);
    const ts = opts.ts ?? Date.now();
    const root = opts.root ?? liveMsTeamsRoot();
    const eb = liveEbWebViewFromRoot(root);
    const profile = liveWorkProfileFromRoot(root);

    if (!existsSync(opts.dest)) {
        throw new Error(`backup missing: ${opts.dest}`);
    }

    if (!dryRun && teamsAppIsUp()) {
        throw new Error("ABORT: New Teams is still running. Quit it first.");
    }

    const entries = readdirSync(opts.dest).filter((name) => !name.startsWith("."));
    const kind = classifyBackup(entries);
    const plan = restorePlan({ dest: opts.dest, entries, eb, profile });
    // `teams-<kind>-<ts>` next to the backup, so listBackups shows it and the
    // same restore command can bring the regenerated copy back.
    const asideDir = `${opts.dest}-replaced-${ts}`;
    const aside = asideMoves(plan, entries, asideDir);

    if (aside.length > 0 && !dryRun) {
        mkdirSync(asideDir, { recursive: true });
    }

    const lines = applyMoves([...aside, ...plan], dryRun);
    log.info({ kind, dest: opts.dest, dryRun, replaced: aside.length }, "[ms-teams] repair restore");
    return { kind, lines };
}

export function liveEbWebViewFromRoot(root: string): string {
    return join(root, "EBWebView");
}

export function liveWorkProfileFromRoot(root: string): string {
    return join(root, "EBWebView", "WV2Profile_tfw");
}

export function defaultRepairRoot(): string {
    return liveMsTeamsRoot();
}

export function defaultRepairProfile(): string {
    return liveWorkProfile();
}

export function defaultRepairEb(): string {
    return liveEbWebView();
}
