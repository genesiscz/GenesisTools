import type { PortInfo } from "@app/dev-dashboard/lib/ports/types";
import { selectWebapps } from "@app/dev-dashboard/lib/ports/webapps";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { listDashboards } from "@app/utils/ui/dashboards";

export { selectWebapps };

/**
 * Most web apps running on this machine are this repo's own dashboards, whose ports are declared in the
 * canonical registry. Matching the listening port there gives the proper human name for free and, since
 * a registered dashboard IS a web app, lets us skip the HTTP probe entirely. PURE lookup under test.
 */
const DASHBOARD_NAME_BY_PORT = new Map<number, string>(listDashboards().map((d) => [d.port, d.name]));

export function dashboardNameForPort(port: number): string | null {
    return DASHBOARD_NAME_BY_PORT.get(port) ?? null;
}

const HTTP_PROBE_TIMEOUT_MS = 300;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Runtimes whose lsof COMMAND ("bun", "node", "python3", "php-fpm"…) is uninformative on its own — for
 * these we resolve the full argv so a row reads as e.g. "bun run dev" instead of a bare "bun".
 */
const GENERIC_RUNTIMES = new Set([
    "bun",
    "node",
    "deno",
    "python",
    "python2",
    "python3",
    "ruby",
    "php",
    "php-fpm",
    "java",
    "dotnet",
    "tsx",
    "ts-node",
    "nodemon",
    "uvicorn",
    "gunicorn",
]);

export function isGenericRuntime(command: string): boolean {
    return GENERIC_RUNTIMES.has(command.toLowerCase());
}

/** A localhost-reachable bind address — the only ones worth an HTTP probe. */
export function isLocalAddress(address: string): boolean {
    return (
        address === "127.0.0.1" ||
        address === "[::1]" ||
        address === "::1" ||
        address === "*" ||
        address === "0.0.0.0" ||
        address === "localhost"
    );
}

export function parsePackageName(json: string): string | null {
    try {
        const parsed = SafeJSON.parse(json) as { name?: unknown };
        if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
            return parsed.name.trim();
        }

        return null;
    } catch (err) {
        logger.debug({ err }, "ports/enrich: package.json parse failed");
        return null;
    }
}

export function parseHtmlTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) {
        return null;
    }

    const title = match[1].replace(/\s+/g, " ").trim();
    return title.length > 0 ? title : null;
}

/** Parse `lsof -Fn` field output, returning the first `n<path>` (the cwd). */
export function parseLsofCwd(stdout: string): string | null {
    for (const line of stdout.split("\n")) {
        if (line.startsWith("n")) {
            const path = line.slice(1).trim();
            if (path.length > 0) {
                return path;
            }
        }
    }

    return null;
}

async function resolveArgv(pid: number): Promise<string | null> {
    try {
        const proc = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "command="], {
            stdout: "pipe",
            stderr: "ignore",
        });
        await proc.exited;
        const out = (await new Response(proc.stdout).text()).trim();
        return out.length > 0 ? out : null;
    } catch (err) {
        logger.debug({ err, pid }, "ports/enrich: ps argv resolution failed");
        return null;
    }
}

async function resolveCwd(pid: number): Promise<string | null> {
    try {
        const proc = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
            stdout: "pipe",
            stderr: "ignore",
        });
        await proc.exited;
        return parseLsofCwd(await new Response(proc.stdout).text());
    } catch (err) {
        logger.debug({ err, pid }, "ports/enrich: lsof cwd resolution failed");
        return null;
    }
}

async function readPackageName(cwd: string): Promise<string | null> {
    try {
        const file = Bun.file(`${cwd}/package.json`);
        if (!(await file.exists())) {
            return null;
        }

        return parsePackageName(await file.text());
    } catch (err) {
        logger.debug({ err, cwd }, "ports/enrich: package.json read failed");
        return null;
    }
}

async function probeHttp(port: number): Promise<{ http: boolean; title: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(`http://localhost:${port}/`, { signal: controller.signal, redirect: "manual" });
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/html")) {
            return { http: true, title: parseHtmlTitle(await res.text()) };
        }

        await res.body?.cancel();
        return { http: true, title: null };
    } catch (err) {
        logger.debug({ err, port }, "ports/enrich: http probe failed (not a web server or timed out)");
        return { http: false, title: null };
    } finally {
        clearTimeout(timeout);
    }
}

interface Enrichment {
    fullCommand?: string;
    title?: string;
    cwd?: string;
    isWebapp?: boolean;
}

const cache = new Map<string, { value: Enrichment; expiresAt: number }>();

function pruneExpired(now: number): void {
    for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) {
            cache.delete(key);
        }
    }
}

async function enrichOne(port: PortInfo): Promise<Enrichment> {
    const key = `${port.pid}:${port.port}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    const enrichment: Enrichment = {};

    if (isGenericRuntime(port.command)) {
        const argv = await resolveArgv(port.pid);
        if (argv) {
            enrichment.fullCommand = argv;
        }
    }

    const cwd = await resolveCwd(port.pid);
    if (cwd) {
        enrichment.cwd = cwd;
    }

    const registryName = dashboardNameForPort(port.port);
    const packageName = cwd ? await readPackageName(cwd) : null;

    if (registryName) {
        // A known repo dashboard: authoritative name, and definitionally a web app — no probe needed.
        enrichment.title = registryName;
        enrichment.isWebapp = true;
    } else if (isLocalAddress(port.address)) {
        const probe = await probeHttp(port.port);
        if (probe.http) {
            enrichment.isWebapp = true;
        }

        const title = packageName ?? probe.title;
        if (title) {
            enrichment.title = title;
        }
    } else if (packageName) {
        enrichment.title = packageName;
    }

    cache.set(key, { value: enrichment, expiresAt: Date.now() + CACHE_TTL_MS });
    return enrichment;
}

/**
 * Enrich a scan with argv / cwd / title / webapp classification. Best-effort and cached per (pid, port)
 * so periodic refreshes stay cheap; every spawn/fetch lives here (server-side), never in the UI.
 */
export async function enrichPorts(ports: PortInfo[]): Promise<PortInfo[]> {
    pruneExpired(Date.now());
    return Promise.all(ports.map(async (p) => ({ ...p, ...(await enrichOne(p)) })));
}
