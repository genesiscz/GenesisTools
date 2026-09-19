import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverTools } from "@app/tools/lib/discovery";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { buildCatalogue, CATALOGUE_VERSION, type ToolCatalogue } from "./catalogue";

const { log } = logger.scoped("jev-route");
const prof = profiler.scope("jev-route");

export function catalogueCachePath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "jev", "route-catalogue.json");
}

function gitHead(srcDir: string): string {
    try {
        const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dirname(srcDir), stdout: "pipe" });
        const head = new TextDecoder().decode(result.stdout).trim();
        return head || "unknown";
    } catch (error) {
        log.debug({ error, srcDir }, "git rev-parse HEAD failed; the catalogue stamp falls back to mtimes only");
        return "unknown";
    }
}

/**
 * A stamp that changes when any source a catalogue row was read from changes.
 *
 * Entry scripts plus every file under each tool's `commands/` directory, because a subcommand
 * is declared there and editing it does not touch the directory's own mtime.
 */
/**
 * How long a computed stamp is reused before the tree is walked again.
 *
 * The stamp exists to decide whether a cached catalogue is stale, but computing it walks every
 * tool directory and its `commands/` folder with synchronous `stat` calls. A CLI run pays that
 * once, which is fine. The HTTP `/route` door and the `jev_route` MCP tool call `loadCatalogue`
 * per request and hold nothing between them, so each request blocked the event loop on a full
 * sync sweep just to confirm a cache that had not changed. Source files do not change several
 * times a second, and a stale answer is bounded by this window.
 */
const STAMP_TTL_MS = 2000;
const stampCache = new Map<string, { at: number; value: string }>();

export function catalogueStamp(srcDir: string): string {
    const cached = stampCache.get(srcDir);

    if (cached && Date.now() - cached.at < STAMP_TTL_MS) {
        return cached.value;
    }

    const value = walkCatalogueStamp(srcDir);
    stampCache.set(srcDir, { at: Date.now(), value });
    return value;
}

function walkCatalogueStamp(srcDir: string): string {
    const tools = discoverTools(srcDir);
    let newest = 0;
    let files = 0;
    for (const tool of tools) {
        for (const path of [tool.path, join(srcDir, tool.name, "commands")]) {
            if (!existsSync(path)) {
                continue;
            }

            const stats = statSync(path);
            if (stats.isDirectory()) {
                for (const entry of readdirSync(path)) {
                    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
                        newest = Math.max(newest, statSync(join(path, entry)).mtimeMs);
                        files += 1;
                    }
                }
                continue;
            }

            newest = Math.max(newest, stats.mtimeMs);
            files += 1;
        }
    }
    return `${tools.length}:${files}:${Math.round(newest)}`;
}

function readCache(path: string): ToolCatalogue | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as ToolCatalogue).tools)) {
            return null;
        }

        return parsed as ToolCatalogue;
    } catch (error) {
        log.warn({ error, path }, "Route catalogue cache is unreadable; rebuilding");
        return null;
    }
}

export function writeCatalogueCache(catalogue: ToolCatalogue, path = catalogueCachePath()): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${SafeJSON.stringify(catalogue, undefined, 0)}\n`, { mode: 0o600 });
    log.info({ path, toolCount: catalogue.tools.length }, "Route catalogue cache written");
}

export interface LoadedCatalogue {
    catalogue: ToolCatalogue;
    cached: boolean;
    ms: number;
    path: string;
}

/**
 * Return the catalogue, rebuilding it when the cache is missing, stale or `refresh` is set.
 *
 * A rebuild spawns one `--help` per tool and takes tens of seconds, so the cache is the normal
 * path and every outcome is logged with the reason.
 */
export async function loadCatalogue(options: {
    srcDir: string;
    refresh?: boolean;
    cachePath?: string;
}): Promise<LoadedCatalogue> {
    const path = options.cachePath ?? catalogueCachePath();
    const started = performance.now();

    // `--refresh` means "do not trust anything cached", so it must drop the memoised stamp too.
    // Keeping it would let a refresh re-read the tree and still compare against a stamp computed
    // up to two seconds ago, which is the one case where a stale stamp changes the answer.
    if (options.refresh) {
        stampCache.delete(options.srcDir);
    }

    // The stamp carries the source directory as well as the mtimes, so a worktree never reads a
    // catalogue another checkout wrote to the same shared path.
    const stamp = `${options.srcDir}|${catalogueStamp(options.srcDir)}`;
    const commit = gitHead(options.srcDir);
    const cached = options.refresh ? null : readCache(path);
    if (cached && cached.version === CATALOGUE_VERSION && cached.stamp === stamp && cached.commit === commit) {
        const ms = Math.round(performance.now() - started);
        log.info({ path, commit, stamp, toolCount: cached.tools.length, ms }, "Route catalogue cache hit");
        return { catalogue: cached, cached: true, ms, path };
    }

    log.info(
        {
            path,
            commit,
            stamp,
            refresh: Boolean(options.refresh),
            reason: options.refresh ? "refresh" : cached ? "stale" : "missing",
        },
        "Route catalogue cache miss; rebuilding"
    );
    const catalogue = await prof.measureAsync("catalogue", async () =>
        buildCatalogue({ srcDir: options.srcDir, commit })
    );
    catalogue.stamp = stamp;
    writeCatalogueCache(catalogue, path);
    return { catalogue, cached: false, ms: Math.round(performance.now() - started), path };
}
