import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";

// PURE cloudflared CLI helpers + thin `Bun.spawn` wrappers. The pure arg/config
// builders (buildCreateArgs/buildRouteDnsArgs/buildRunArgs/buildConfigYaml/parseTunnelId)
// are the unit-tested surface; the spawn wrappers (detect/install/login/run/route/create/
// writeConfig) shell out to the `cloudflared` BINARY and are never exercised in tests.
// No prompts live here — the wizard (`commands/tunnel.ts`) owns the interaction.

const TUNNEL_UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export interface CloudflaredResult {
    code: number;
    stdout: string;
    stderr: string;
}

// ── Pure builders (unit-tested) ───────────────────────────────────────────────

export function buildCreateArgs(name: string): string[] {
    return ["tunnel", "create", name];
}

export function buildRouteDnsArgs(name: string, hostname: string): string[] {
    return ["tunnel", "route", "dns", name, hostname];
}

export function buildRunArgs(name: string, port: number): string[] {
    return ["tunnel", "run", "--url", `http://127.0.0.1:${port}`, name];
}

export function parseTunnelId(stdout: string): string | null {
    return stdout.match(TUNNEL_UUID_RE)?.[1] ?? null;
}

export interface TunnelConfigInput {
    tunnelId: string;
    /** Path to the tunnel credentials file `cloudflared tunnel create` wrote. */
    credentialsFile: string;
    hostname: string;
    localPort: number;
}

/**
 * Build the `~/.cloudflared/<id>.yml` config that maps the public hostname to the
 * local dashboard port (ingress) and points cloudflared at its credentials file.
 * Pure string assembly (no disk) so it can be unit-tested deterministically.
 */
export function buildConfigYaml(input: TunnelConfigInput): string {
    return [
        `tunnel: ${input.tunnelId}`,
        `credentials-file: ${input.credentialsFile}`,
        "ingress:",
        `  - hostname: ${input.hostname}`,
        `    service: http://127.0.0.1:${input.localPort}`,
        "  - service: http_status:404",
        "",
    ].join("\n");
}

/** Default location cloudflared looks for per-tunnel config + credentials. */
export function cloudflaredHome(): string {
    return join(homedir(), ".cloudflared");
}

// ── Spawn wrappers (NOT unit-tested — they run the real binary) ────────────────

export async function detectCloudflared(): Promise<{ installed: boolean; version?: string }> {
    try {
        const proc = Bun.spawn(["cloudflared", "--version"], { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;

        return { installed: proc.exitCode === 0, version: out.trim() || undefined };
    } catch (err) {
        logger.debug({ err }, "dev-dashboard: cloudflared not detected");
        return { installed: false };
    }
}

/** Best-effort install on macOS via Homebrew; returns true on success. */
export async function installCloudflared(): Promise<boolean> {
    try {
        const proc = Bun.spawn(["brew", "install", "cloudflared"], { stdout: "inherit", stderr: "inherit" });
        await proc.exited;

        return proc.exitCode === 0;
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: cloudflared install via brew failed");
        return false;
    }
}

/** Runs a cloudflared subcommand, returning {code, stdout, stderr}. */
export async function runCloudflared(args: string[]): Promise<CloudflaredResult> {
    const proc = Bun.spawn(["cloudflared", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    logger.info({ args, code: proc.exitCode }, "dev-dashboard: cloudflared command");

    return { code: proc.exitCode ?? -1, stdout, stderr };
}

/** `cloudflared tunnel login` opens a browser; we surface the URL it prints and wait. */
export async function loginCloudflared(): Promise<CloudflaredResult> {
    return runCloudflared(["tunnel", "login"]);
}

export interface CreateTunnelResult {
    tunnelId: string | null;
    raw: CloudflaredResult;
}

/** Create a named tunnel; returns the parsed tunnel id (null if cloudflared didn't print one). */
export async function createTunnel(name: string): Promise<CreateTunnelResult> {
    const raw = await runCloudflared(buildCreateArgs(name));
    return { tunnelId: parseTunnelId(`${raw.stdout}\n${raw.stderr}`), raw };
}

/** Route a DNS hostname at the named tunnel (creates the CNAME in the user's CF zone). */
export async function routeDns(name: string, hostname: string): Promise<CloudflaredResult> {
    return runCloudflared(buildRouteDnsArgs(name, hostname));
}

/**
 * Persist the per-tunnel config to `~/.cloudflared/<tunnelId>.yml` (the ingress map).
 * Returns the path written.
 */
export async function writeConfig(input: TunnelConfigInput): Promise<string> {
    const path = join(cloudflaredHome(), `${input.tunnelId}.yml`);
    await Bun.write(path, buildConfigYaml(input));
    logger.info({ path, hostname: input.hostname }, "dev-dashboard: cloudflared config written");

    return path;
}

/**
 * Spawn `cloudflared tunnel run` in the foreground (long-lived). The caller owns the
 * process lifecycle — this returns the handle so the wizard / a service supervisor can
 * stop it. NOT used by tests.
 */
export function runTunnel(name: string, port: number): ReturnType<typeof Bun.spawn> {
    logger.info({ name, port }, "dev-dashboard: starting cloudflared tunnel run");
    return Bun.spawn(["cloudflared", ...buildRunArgs(name, port)], { stdout: "inherit", stderr: "inherit" });
}

// ── Managed (sub)domain (D10) — DevDashboard Cloud API (plan 10) ───────────────

export interface ManagedSubdomainRequest {
    cloudApiToken: string;
    desiredName: string;
}

export interface ManagedSubdomainResult {
    /** The reserved fully-qualified hostname, e.g. `martin.devdashboard.app`. */
    hostname: string;
    /** Routing config the wizard feeds into the user's own cloudflared tunnel. */
    routing: {
        /** CNAME / custom-hostname target the user's tunnel should be reachable at. */
        target: string;
    };
    /**
     * Whether the VENDOR's CF account fronts this subdomain (TLS terminates at the vendor
     * edge). When true the managed-tier E2E layer is REQUIRED for the no-see claim; when
     * false (DNS delegated to the user's own CF) tier-3 trust is preserved. The wizard
     * prints which property applies. Plan 10 decides the implementation.
     */
    vendorFronted: boolean;
}

/**
 * Reserve a managed `<name>.devdashboard.app` subdomain via the DevDashboard Cloud API
 * (D10). The Cloud API is built in plan 10 — this is the typed seam the wizard codes
 * against today. Do NOT invent endpoints here; plan 10 wires the real HTTP call.
 */
export async function requestManagedSubdomain(
    req: ManagedSubdomainRequest
): Promise<ManagedSubdomainResult> {
    // TODO(plan-10): call the DevDashboard Cloud API to reserve `req.desiredName` against
    // the user's account (Cloudflare for SaaS custom hostnames or a vendor wildcard zone)
    // and return the reserved hostname + routing config. Endpoints are defined in plan 10.
    logger.warn(
        { desiredName: req.desiredName },
        "dev-dashboard: requestManagedSubdomain called but DevDashboard Cloud API is not implemented (plan 10)"
    );
    throw new Error("DevDashboard Cloud API not implemented (plan 10): managed subdomains are not yet available");
}
