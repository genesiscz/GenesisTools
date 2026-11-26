import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { listenOrigin } from "@genesiscz/utils/publish/exposure";
import type { Subprocess } from "bun";

const { log } = logger.scoped("share-tunnel");

export { TUNNEL_NAME_RE } from "@genesiscz/utils/publish/exposure";
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Where `share-server tunnel` writes the connector config, and `share-server serve --tunnel <name>` reads it. */
export function tunnelConfigPath(stateDir: string, name: string): string {
    return join(stateDir, `cloudflared-${name}.yml`);
}

/**
 * The connector config: `hostname` reaches the share server and nothing else on this machine. The share server
 * answers only its pages and its upload API (its admin face is a unix socket), and every other host gets 404.
 */
export function cloudflaredConfig(options: {
    tunnelId: string;
    credentialsFile: string;
    hostname: string;
    port: number;
    host?: string;
}): string {
    return [
        `tunnel: ${options.tunnelId}`,
        `credentials-file: ${SafeJSON.stringify(options.credentialsFile)}`,
        "ingress:",
        `  - hostname: ${options.hostname}`,
        `    service: ${listenOrigin(options.host ?? "127.0.0.1", options.port)}`,
        "  - service: http_status:404",
        "",
    ].join("\n");
}

export interface TunnelStep {
    why: string;
    command: string[];
    /** True when the step opens a browser or waits for the person (cloudflared login). */
    interactive?: boolean;
}

/** The cloudflared steps that give a share server a public hostname with no web server in front. */
export function tunnelSetupSteps(options: { name: string; hostname: string }): TunnelStep[] {
    return [
        {
            why: "log this machine in to Cloudflare (opens a URL; pick the zone)",
            command: ["cloudflared", "tunnel", "login"],
            interactive: true,
        },
        {
            why: "create the named tunnel and its credentials file",
            command: ["cloudflared", "tunnel", "create", options.name],
        },
        {
            why: `point ${options.hostname} at the tunnel (a proxied CNAME in Cloudflare DNS)`,
            command: ["cloudflared", "tunnel", "route", "dns", options.name, options.hostname],
        },
    ];
}

/** Start the cloudflared connector beside the share server; it stops with the server. */
export function startTunnelConnector(options: { name: string; configFile: string }): Subprocess {
    log.info({ tunnel: options.name, config: options.configFile }, "starting the cloudflared connector");

    return Bun.spawn(
        ["cloudflared", "tunnel", "--no-autoupdate", "--config", options.configFile, "run", options.name],
        {
            stdout: "inherit",
            stderr: "inherit",
        }
    );
}
