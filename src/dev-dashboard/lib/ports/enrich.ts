import { join } from "node:path";
import {
    deriveTitle,
    deriveVisibility,
    isVerifiedGenesisTools,
    kindFromProbe,
} from "@app/dev-dashboard/lib/ports/classify";
import { applyClassifyCache, rememberClassify } from "@app/dev-dashboard/lib/ports/classify-cache";
import { isLocalAddress, parsePackageName } from "@app/dev-dashboard/lib/ports/enrich-parse";
import { probeHttp } from "@app/dev-dashboard/lib/ports/probe";
import { batchCwds, batchProcessMeta } from "@app/dev-dashboard/lib/ports/resolve";
import type { PortInfo } from "@app/dev-dashboard/lib/ports/types";
import { logger } from "@app/logger";

// Re-exports for existing tests / callers that import parse helpers from enrich.
export { dashboardNameForPort } from "@app/dev-dashboard/lib/ports/classify";
export {
    isGenericRuntime,
    isLocalAddress,
    parseHtmlTitle,
    parseLsofCwd,
    parsePackageName,
} from "@app/dev-dashboard/lib/ports/enrich-parse";
export { selectWebapps } from "@app/dev-dashboard/lib/ports/webapps";

const CACHE_TTL_MS = 5 * 60_000;
const packageCache = new Map<string, { name: string | null; expiresAt: number }>();

async function readPackageName(cwd: string): Promise<string | null> {
    const cached = packageCache.get(cwd);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.name;
    }

    try {
        const file = Bun.file(join(cwd, "package.json"));
        if (!(await file.exists())) {
            packageCache.set(cwd, { name: null, expiresAt: Date.now() + CACHE_TTL_MS });
            return null;
        }

        const name = parsePackageName(await file.text());
        packageCache.set(cwd, { name, expiresAt: Date.now() + CACHE_TTL_MS });
        return name;
    } catch (err) {
        logger.debug({ err, cwd }, "ports/enrich: package.json read failed");
        return null;
    }
}

/**
 * Fast enrichment: batch resolve argv/cwd/start, derive titles + visibility + genesis-tools flag.
 * Does NOT HTTP-probe — that is progressive via `classifyPortBatch` / SSE so the UI can paint first.
 */
export async function enrichPortsMeta(ports: PortInfo[]): Promise<PortInfo[]> {
    if (ports.length === 0) {
        return ports;
    }

    const pids = ports.map((p) => p.pid);
    const [metaMap, cwdMap] = await Promise.all([batchProcessMeta(pids), batchCwds(pids)]);

    const uniqueCwds = [...new Set([...cwdMap.values()])];
    const packageByCwd = new Map<string, string | null>();
    await Promise.all(
        uniqueCwds.map(async (cwd) => {
            packageByCwd.set(cwd, await readPackageName(cwd));
        })
    );

    const mapped = ports.map((p) => {
        const meta = metaMap.get(p.pid);
        const cwd = cwdMap.get(p.pid);
        const fullCommand = meta?.fullCommand;
        const command = meta?.shortCommand ?? p.command;
        const packageName = cwd ? (packageByCwd.get(cwd) ?? null) : null;
        const isGenesisTools = isVerifiedGenesisTools(p.port, fullCommand, cwd, command);
        const visibility = deriveVisibility({ port: p.port, command, fullCommand, cwd });
        const title = deriveTitle({
            port: p.port,
            command,
            fullCommand,
            cwd,
            packageName,
        });

        const startedAt =
            meta?.startedAtMs !== null && meta?.startedAtMs !== undefined
                ? new Date(meta.startedAtMs).toISOString()
                : undefined;

        const skipProbe = visibility !== "normal" || !isLocalAddress(p.address);

        return {
            ...p,
            command,
            fullCommand: fullCommand ?? p.fullCommand,
            cwd: cwd ?? p.cwd,
            title,
            startedAt,
            visibility,
            isGenesisTools,
            kind: isGenesisTools ? "genesis-tools" : undefined,
            probeStatus: skipProbe ? "skipped" : "pending",
            isWebapp: undefined,
        } satisfies PortInfo;
    });

    return applyClassifyCache(mapped);
}

/**
 * Run HTTP probes for ports still `probeStatus: "pending"`. Returns only the updated rows
 * (for SSE batches). Does not mutate inputs.
 */
export async function classifyPortBatch(ports: PortInfo[]): Promise<PortInfo[]> {
    const pending = ports.filter((p) => p.probeStatus === "pending");
    if (pending.length === 0) {
        return [];
    }

    const byPort = new Map<number, PortInfo[]>();
    for (const p of pending) {
        const list = byPort.get(p.port) ?? [];
        list.push(p);
        byPort.set(p.port, list);
    }

    const probeByPort = new Map<number, Awaited<ReturnType<typeof probeHttp>>>();
    await Promise.all(
        [...byPort.keys()].map(async (port) => {
            probeByPort.set(port, await probeHttp(port));
        })
    );

    const out: PortInfo[] = [];

    for (const [port, rows] of byPort) {
        const probe = probeByPort.get(port) ?? {
            http: false,
            contentClass: "none" as const,
            title: null,
        };
        const isGenesisTools = rows[0].isGenesisTools === true;
        const classified = kindFromProbe({
            isGenesisTools,
            http: probe.http,
            contentClass: probe.contentClass,
        });

        for (const row of rows) {
            const title = row.isGenesisTools && row.title ? row.title : (probe.title ?? row.title);

            out.push({
                ...row,
                title,
                kind: classified.kind,
                isWebapp: classified.isWebapp,
                probeStatus: "done",
            });
        }
    }

    rememberClassify(out);
    return out;
}

/**
 * Full enrich including HTTP (single-shot). Prefer meta + classify stream for the UI.
 */
export async function enrichPorts(ports: PortInfo[]): Promise<PortInfo[]> {
    const withMeta = await enrichPortsMeta(ports);
    const classified = await classifyPortBatch(withMeta);
    if (classified.length === 0) {
        return withMeta;
    }

    const byKey = new Map(classified.map((p) => [`${p.pid}:${p.port}:${p.proto}`, p]));
    return withMeta.map((p) => byKey.get(`${p.pid}:${p.port}:${p.proto}`) ?? p);
}
