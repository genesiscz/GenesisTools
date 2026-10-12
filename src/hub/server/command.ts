import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { askHubServer } from "./client";
import { HUB_SERVER_DOORS } from "./doors";
import { hubServerSocketPath } from "./paths";
import { startHubServer } from "./server";

const DEFAULT_MAX_MB = 512;
const IDLE_MS = 10 * 60_000;
const CHECK_EVERY_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;

interface ServeFlags {
    status?: boolean;
    drain?: boolean;
    json?: boolean;
    idle?: boolean;
}

function maxFootprintBytes(): number {
    const configured = env.tools.getHubServerMaxMb();
    return (configured > 0 ? configured : DEFAULT_MAX_MB) * 1024 * 1024;
}

async function serve(flags: ServeFlags): Promise<void> {
    if (flags.status || flags.drain) {
        const probe = await askHubServer(flags.drain ? "drain" : "health", { timeoutMs: 2000 });
        const answer = probe.state === "answers" ? probe.reply : null;
        if (!answer) {
            out.printlnErr(`No hub server answers on ${hubServerSocketPath()}`);
            process.exitCode = 1;
            return;
        }

        if (flags.json || flags.drain) {
            out.result(answer);
            return;
        }

        const health = answer.health;
        if (typeof health === "object" && health !== null) {
            for (const [key, value] of Object.entries(health)) {
                out.println(`${key.padEnd(14)} ${Array.isArray(value) ? value.join(", ") : String(value)}`);
            }
        }

        return;
    }

    await withInterrupt(async (signal) => {
        let stopped: (() => void) | undefined;
        const done = new Promise<void>((resolve) => {
            stopped = resolve;
        });
        const sourceRoot = new URL("../../", import.meta.url).pathname;
        const handle = await startHubServer({
            socketPath: hubServerSocketPath(),
            doors: HUB_SERVER_DOORS,
            maxFootprintBytes: maxFootprintBytes(),
            idleMs: flags.idle === false ? 0 : IDLE_MS,
            checkEveryMs: CHECK_EVERY_MS,
            callTimeoutMs: CALL_TIMEOUT_MS,
            sourceRoot,
            onStopped: (reason) => {
                logger.info({ reason }, "hub server process exiting");
                stopped?.();
            },
        });
        if (!handle) {
            out.printlnErr(`A hub server already answers on ${hubServerSocketPath()}`);
            return;
        }

        const stop = (): void => {
            void handle.drain("signal");
        };
        signal.addEventListener("abort", stop, { once: true });
        process.once("SIGTERM", stop);
        out.printlnErr(`hub server listening on ${hubServerSocketPath()} (pid ${process.pid})`);
        await done;
    });
    // The orphan watchdog, the fs watchers and the logger may keep the loop alive; the server is done.
    process.exit(0);
}

export function registerServeCommand(program: Command): void {
    program
        .command("serve")
        .description(
            "Run the resident hub server: GenesisTools.app's hub asks it over a unix socket instead of starting a tools process per call"
        )
        .option("--status", "print the running server's health and exit")
        .option("--drain", "ask the running server to finish its calls and exit (the hub starts the new code)")
        .option("--json", "with --status: machine-readable output")
        .option("--no-idle", "do not exit after 10 minutes with no connection")
        .action((flags: ServeFlags) => serve(flags));
}
