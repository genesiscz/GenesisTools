#!/usr/bin/env bun

import { handleReadmeFlag } from "@app/utils/readme";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { registerDaemonCommands } from "./commands/daemon";
import { runWakeServer } from "./lib/server";
import { sendWakePacket } from "./lib/wol";

handleReadmeFlag(import.meta.url);

const program = new Command();

program.name("wakeup").description("Wake-on-LAN helper and tiny wake relay").version("1.0.0");

program
    .command("send")
    .description("Send a Wake-on-LAN magic packet")
    .requiredOption("-m, --mac <mac>", "Target MAC address (e.g., 01:23:45:67:89:ab)")
    .option("-b, --broadcast <addr>", "Broadcast address", "255.255.255.255")
    .option("-p, --port <port>", "UDP port", "9")
    .option("--password <hex>", "Optional SecureOn password (hex)")
    .action(async (opts: Record<string, unknown>) => {
        const port = Number(opts.port ?? 9);

        if (Number.isNaN(port) || port <= 0 || port > 65535) {
            p.log.error("Invalid UDP port");
            process.exit(1);
        }

        try {
            const result = await sendWakePacket({
                mac: String(opts.mac),
                broadcast: String(opts.broadcast ?? "255.255.255.255"),
                port,
                password: opts.password as string | undefined,
            });
            p.log.success(
                `Magic packet sent to ${pc.cyan(result.mac)} via ${result.broadcast}:${result.port} (${result.bytesSent} bytes)`
            );
        } catch (err) {
            p.log.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program
    .command("server")
    .description("Run a minimal HTTP relay that forwards wake requests to a MAC address")
    .option("-p, --port <port>", "HTTP port to listen on", "8787")
    .option("--bind <host>", "Bind host", "0.0.0.0")
    .option("-b, --broadcast <addr>", "Default broadcast address", "255.255.255.255")
    .option("--wol-port <port>", "UDP port for magic packet", "9")
    .option("-m, --default-mac <mac>", "Default MAC address if request omits one")
    .option("-t, --token <token>", "Shared secret; require Authorization: Bearer <token>")
    .option("--log-requests", "Log incoming wake attempts", false)
    .action(async (opts: Record<string, unknown>) => {
        const port = Number(opts.port ?? 8787);
        const wolPort = Number(opts.wolPort ?? 9);

        if (Number.isNaN(port) || port <= 0 || port > 65535) {
            p.log.error("Invalid port");
            process.exit(1);
        }

        if (Number.isNaN(wolPort) || wolPort <= 0 || wolPort > 65535) {
            p.log.error("Invalid wol-port");
            process.exit(1);
        }

        p.log.info(
            `Starting wake server on ${opts.bind ?? "0.0.0.0"}:${port} (broadcast ${opts.broadcast ?? "255.255.255.255"}:${wolPort})`
        );

        await runWakeServer({
            port,
            hostname: (opts.bind as string | undefined) ?? "0.0.0.0",
            broadcast: (opts.broadcast as string | undefined) ?? "255.255.255.255",
            wolPort,
            defaultMac: opts.defaultMac as string | undefined,
            token: opts.token as string | undefined,
            logRequests: Boolean(opts.logRequests),
        });
    });

registerDaemonCommands(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
