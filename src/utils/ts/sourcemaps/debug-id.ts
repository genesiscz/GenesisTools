import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzip } from "@genesiscz/utils/fs/unzip";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

const { log } = logger.scoped("ts:sourcemaps:debug-id");
const prof = profiler.scope("sourcemaps");

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// ECMA-426: `//# debugId=<uuid>` in the last lines of the file.
const DEBUG_ID_COMMENT = new RegExp(`//# debugId=(${UUID})`);
// Sentry's bundler plugins inject a snippet before minification that survives it as a string literal.
const SENTRY_SNIPPET = new RegExp(`sentry-dbid-(${UUID})`);
const UUID_FILE_NAME = new RegExp(`(${UUID})`);

/**
 * The debug id a built JS file carries, lower case: the ECMA-426 `//# debugId=` comment first, else the
 * `sentry-dbid-<uuid>` literal of Sentry's injected snippet. Null when it carries neither.
 */
export function debugIdOf(code: string): string | null {
    const fromComment = DEBUG_ID_COMMENT.exec(code.slice(-4096))?.[1];
    if (fromComment) {
        return fromComment.toLowerCase();
    }

    return SENTRY_SNIPPET.exec(code)?.[1]?.toLowerCase() ?? null;
}

/** Somewhere a source map can be fetched by debug id. Never the primary source: published maps come first. */
export interface DebugIdMapSource {
    readonly name: string;
    /** The map JSON text, or null when this source has no map for the id. Throws on a transport error. */
    mapFor(debugId: string): Promise<string | null>;
}

interface ArtifactManifest {
    files?: Record<string, { url?: string; type?: string; headers?: Record<string, string> }>;
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
    const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
    return entry?.[1];
}

/**
 * The source maps inside a Sentry artifact bundle (a zip with `manifest.json`), by debug id: entries of type
 * `source_map` carry a `debug-id` header; a `minified_source` with a `sourcemap` header names its map instead.
 */
export function mapsInArtifactBundle(files: Map<string, Uint8Array>): Map<string, string> {
    const decoder = new TextDecoder();
    const manifestBytes = files.get("manifest.json");
    if (!manifestBytes) {
        return new Map();
    }

    const manifest = SafeJSON.parse(decoder.decode(manifestBytes), { strict: true }) as ArtifactManifest;
    const entries = Object.entries(manifest.files ?? {});
    const maps = new Map<string, string>();
    for (const [path, entry] of entries) {
        const id = header(entry.headers, "debug-id")?.toLowerCase();
        const bytes = files.get(path);
        if (!id || !bytes) {
            continue;
        }

        if (entry.type === "source_map") {
            maps.set(id, decoder.decode(bytes));
            continue;
        }

        const named = header(entry.headers, "sourcemap");
        if (entry.type === "minified_source" && named && !maps.has(id)) {
            const mapEntry = entries.find(
                ([, other]) => other.url?.endsWith(named) || other.url?.endsWith(`/${named}`)
            );
            const mapBytes = mapEntry ? files.get(mapEntry[0]) : undefined;
            if (mapBytes) {
                maps.set(id, decoder.decode(mapBytes));
            }
        }
    }

    return maps;
}

/**
 * Maps the caller fetched by any means (Sentry UI, sentry-cli, an MCP tool, a CI artifact), in one folder:
 * files named after the debug id (`<id>.map`, `<id>.js.map`), maps whose JSON has `debug_id`/`debugId`, and
 * Sentry artifact bundles (`.zip`).
 */
export class DirectoryMapSource implements DebugIdMapSource {
    readonly name: string;
    private index: Promise<Map<string, () => Promise<string>>> | null = null;

    constructor(private readonly dir: string) {
        this.name = `maps folder ${dir}`;
    }

    private async buildIndex(): Promise<Map<string, () => Promise<string>>> {
        const index = new Map<string, () => Promise<string>>();
        const entries = await readdir(this.dir, { recursive: true });
        for (const relative of entries) {
            const path = join(this.dir, relative);
            if (relative.endsWith(".zip")) {
                const maps = mapsInArtifactBundle(unzip(new Uint8Array(await readFile(path))));
                for (const [id, text] of maps) {
                    index.set(id, async () => text);
                }

                continue;
            }

            if (!relative.endsWith(".map")) {
                continue;
            }

            const named = UUID_FILE_NAME.exec(relative)?.[1]?.toLowerCase();
            if (named) {
                index.set(named, () => readFile(path, "utf8"));
                continue;
            }

            const text = await readFile(path, "utf8");
            let parsed: { debug_id?: unknown; debugId?: unknown };
            try {
                parsed = SafeJSON.parse(text, { strict: true }) as { debug_id?: unknown; debugId?: unknown };
            } catch (err) {
                // One broken file must not take the whole folder (and every valid map in it) down.
                log.warn({ err, path }, "skipping a .map that is not JSON");
                continue;
            }

            const id = parsed?.debug_id ?? parsed?.debugId;
            if (typeof id === "string") {
                index.set(id.toLowerCase(), async () => text);
            }
        }

        log.info({ dir: this.dir, maps: index.size }, "maps folder indexed");
        return index;
    }

    async mapFor(debugId: string): Promise<string | null> {
        this.index ??= prof.measureAsync("debug-id.maps-folder", () => this.buildIndex());
        const load = (await this.index).get(debugId.toLowerCase());
        return load ? load() : null;
    }
}

export interface SentryLocation {
    /** The Sentry base URL, e.g. https://sentry.example.com (self-hosted) or https://sentry.io. */
    url: string;
    org: string;
    project: string;
    /** An auth token with project:read; downloading needs the org's debug-file download permission too. */
    token: string;
    /** PEM certificates for a Sentry behind a private CA, up to the root (see `completeCaChain`). */
    ca?: string | string[];
}

/**
 * Sentry's artifact lookup: `GET /api/0/projects/<org>/<project>/artifact-lookup/?debug_id=<uuid>` lists the
 * artifact bundles holding that debug id; each `url` downloads one bundle (a zip). Bundles are fetched once
 * per process, and Sentry rate-limits downloads (10 per bundle), so callers should keep the maps they get.
 */
export class SentryArtifactSource implements DebugIdMapSource {
    readonly name: string;
    private readonly bundles = new Map<string, Promise<Map<string, string>>>();

    constructor(
        private readonly location: SentryLocation,
        private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
            fetch(url, init)
    ) {
        this.name = `sentry ${new URL(location.url).host} ${location.org}/${location.project}`;
    }

    private init(): RequestInit & { tls?: { ca?: string | string[] } } {
        return {
            headers: { authorization: `Bearer ${this.location.token}` },
            ...(this.location.ca ? { tls: { ca: this.location.ca } } : {}),
        };
    }

    private async get(url: string, what: string): Promise<Response> {
        const response = await prof.measureAsync(`debug-id.sentry.${what.replaceAll(" ", "-")}`, () =>
            this.fetcher(url, this.init())
        );
        if (response.ok) {
            return response;
        }

        const reason =
            response.status === 401
                ? "the token was refused"
                : response.status === 403
                  ? what === "bundle download"
                      ? "Sentry has a bundle with this debug id but refused the download: it needs an org role at or above the debug-files role (Organization settings > Security & Privacy; default admin), or a team admin token with project:write"
                      : "the token lacks permission for this project"
                  : response.status === 404
                    ? "no such org or project"
                    : response.status === 429
                      ? "rate limited (Sentry allows few downloads per bundle)"
                      : `HTTP ${response.status}`;
        throw new Error(`sentry ${what}: ${reason}`);
    }

    private bundle(url: string): Promise<Map<string, string>> {
        let pending = this.bundles.get(url);
        if (!pending) {
            pending = this.get(url, "bundle download")
                .then(async (response) => mapsInArtifactBundle(unzip(new Uint8Array(await response.arrayBuffer()))))
                .catch((err: unknown) => {
                    this.bundles.delete(url);
                    throw err;
                });
            this.bundles.set(url, pending);
        }

        return pending;
    }

    async mapFor(debugId: string): Promise<string | null> {
        const base = this.location.url.replace(/\/+$/, "");
        const lookup = `${base}/api/0/projects/${encodeURIComponent(this.location.org)}/${encodeURIComponent(this.location.project)}/artifact-lookup/?debug_id=${encodeURIComponent(debugId)}`;
        const response = await this.get(lookup, "artifact lookup");
        const artifacts = SafeJSON.parse(await response.text(), { strict: true }) as Array<{
            id?: string;
            type?: string;
            url?: string;
        }>;
        log.debug({ debugId, artifacts: artifacts.length }, "sentry artifact lookup");
        for (const artifact of artifacts) {
            if (artifact.type !== "bundle" || !artifact.url) {
                continue;
            }

            // A self-hosted Sentry behind a proxy builds this link from the host it sees (often an internal
            // name such as `http://sentry/...`); the download is a route on the same endpoint, so keep its path
            // and query and use the host the caller reached.
            const download = new URL(artifact.url);
            const reached = new URL(base);
            download.protocol = reached.protocol;
            download.host = reached.host;
            const map = (await this.bundle(download.href)).get(debugId.toLowerCase());
            if (map) {
                return map;
            }
        }

        return null;
    }
}
