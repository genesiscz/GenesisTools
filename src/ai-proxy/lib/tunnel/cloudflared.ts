import { existsSync } from "node:fs";
import { normalizeBasePath } from "@app/ai-proxy/lib/path-prefix";
import { resolveCloudflaredConfigPath } from "@app/ai-proxy/lib/public-url";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { detectCloudflared, installCloudflared } from "@app/dev-dashboard/lib/tunnel/cloudflared";
import { logger } from "@app/logger";

export { detectCloudflared, installCloudflared };

export const AI_PROXY_INGRESS_MARKER = "# ai-proxy (managed by tools ai-proxy)";

export interface AiProxyIngressRule {
    hostname: string;
    basePath: string;
    port: number;
}

export interface MergeIngressResult {
    yaml: string;
    changed: boolean;
    removedLegacyRules: number;
}

export function buildAiProxyIngressBlock(rule: AiProxyIngressRule): string {
    const basePath = normalizeBasePath(rule.basePath) || "/ai";

    return [
        `  ${AI_PROXY_INGRESS_MARKER}`,
        `  - hostname: ${rule.hostname}`,
        `    path: ${basePath}`,
        `    service: http://127.0.0.1:${rule.port}`,
    ].join("\n");
}

export function parseTunnelNameFromConfig(yaml: string): string | null {
    for (const line of yaml.split("\n")) {
        const match = line.match(/^tunnel:\s*(\S+)\s*$/);
        if (match?.[1]) {
            return match[1];
        }
    }

    return null;
}

function isIngressCatchAll(line: string): boolean {
    return /^\s*-\s+service:\s+http_status:404\s*$/.test(line);
}

function ingressEntryText(lines: string[], index: number): string {
    const end = skipIngressEntry(lines, index);
    return lines.slice(index, end).join("\n");
}

/** Hostname rule without path — matches every path on that host (e.g. dev-dashboard). */
function isHostnameCatchAllEntry(lines: string[], index: number): boolean {
    const line = lines[index] ?? "";

    if (!/^\s{2}-\s+hostname:/.test(line)) {
        return false;
    }

    const entry = ingressEntryText(lines, index);
    return entry.includes("service:") && !/\bpath:/.test(entry);
}

function isAiProxyMarkerLine(line: string): boolean {
    return line.includes(AI_PROXY_INGRESS_MARKER) || (line.includes("ai-proxy") && line.includes("#"));
}

function isAiProxyIngressEntry(lines: string[], index: number, rule: AiProxyIngressRule): boolean {
    const line = lines[index] ?? "";

    if (isAiProxyMarkerLine(line)) {
        return true;
    }

    if (!/^\s{2}-\s+hostname:/.test(line)) {
        return false;
    }

    const basePath = normalizeBasePath(rule.basePath) || "/ai";
    const entry = ingressEntryText(lines, index);

    return (
        entry.includes(`hostname: ${rule.hostname}`) &&
        entry.includes(`path: ${basePath}`) &&
        entry.includes(`127.0.0.1:${rule.port}`)
    );
}

function skipIngressEntry(lines: string[], start: number): number {
    let i = start;

    if (isAiProxyMarkerLine(lines[i] ?? "")) {
        i += 1;
    }

    if (i < lines.length && /^\s{2}-\s+hostname:/.test(lines[i] ?? "")) {
        i += 1;
        while (i < lines.length && /^\s{4,}\S/.test(lines[i] ?? "")) {
            i += 1;
        }
    }

    return i;
}

export function mergeAiProxyIngress(configYaml: string, rule: AiProxyIngressRule): MergeIngressResult {
    const lines = configYaml.split("\n");
    let removedLegacyRules = 0;
    let hasIngress = false;
    let inserted = false;
    const cleaned: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";

        if (line.trim() === "ingress:") {
            hasIngress = true;
            cleaned.push(line);
            continue;
        }

        if (hasIngress && isAiProxyIngressEntry(lines, i, rule)) {
            removedLegacyRules += 1;
            i = skipIngressEntry(lines, i) - 1;
            continue;
        }

        if (hasIngress && !inserted && (isHostnameCatchAllEntry(lines, i) || isIngressCatchAll(line))) {
            cleaned.push(buildAiProxyIngressBlock(rule));
            inserted = true;
        }

        cleaned.push(line);
    }

    if (!hasIngress) {
        const block = buildAiProxyIngressBlock(rule);
        const appended = `${configYaml.trimEnd()}\ningress:\n${block}\n  - service: http_status:404\n`;

        return { yaml: appended, changed: true, removedLegacyRules: 0 };
    }

    if (!inserted) {
        cleaned.push(buildAiProxyIngressBlock(rule));
        inserted = true;
    }

    const changed = inserted || removedLegacyRules > 0;

    return {
        yaml: `${cleaned.join("\n").trimEnd()}\n`,
        changed,
        removedLegacyRules,
    };
}

export async function readCloudflaredConfig(config: AiProxyConfig): Promise<string | null> {
    const path = resolveCloudflaredConfigPath(config.public);

    if (!existsSync(path)) {
        return null;
    }

    return Bun.file(path).text();
}

export async function writeCloudflaredConfig(config: AiProxyConfig, yaml: string): Promise<string> {
    const path = resolveCloudflaredConfigPath(config.public);
    await Bun.write(path, yaml);
    return path;
}

export function isTunnelProcessRunning(tunnelName?: string): boolean {
    try {
        const proc = Bun.spawnSync({
            cmd: ["pgrep", "-fl", "cloudflared"],
            stdout: "pipe",
            stderr: "ignore",
        });

        const output = proc.stdout.toString();
        if (!output.trim()) {
            return false;
        }

        if (!tunnelName) {
            return output.includes("cloudflared");
        }

        return output.includes(`tunnel run ${tunnelName}`) || output.includes(`tunnel run ${tunnelName} `);
    } catch (err) {
        logger.debug({ err, tunnelName }, "ai-proxy cloudflared: tunnel process check failed");
        return false;
    }
}

export async function probeUrl(url: string, apiKey?: string): Promise<{ ok: boolean; status: number; body: string }> {
    try {
        const headers: Record<string, string> = {};
        if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        const body = await response.text();

        return { ok: response.ok, status: response.status, body };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, body: message };
    }
}
