import { logger } from "@app/logger";

const log = logger.child({ component: "agents:lifecycle" });

export type ShutdownReason = "signal" | "clean_exit" | "cap";

export type ShutdownHandler = (reason: ShutdownReason) => Promise<void> | void;

const handlers: ShutdownHandler[] = [];
let signalsInstalled = false;
let shuttingDown = false;

async function runHandlers(reason: ShutdownReason): Promise<void> {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    const ordered = [...handlers].reverse();

    for (const handler of ordered) {
        try {
            await handler(reason);
        } catch (err) {
            log.warn({ err }, "shutdown handler threw");
        }
    }
}

function installSignals(): void {
    if (signalsInstalled) {
        return;
    }

    signalsInstalled = true;
    const onSignal = async (sig: NodeJS.Signals): Promise<void> => {
        log.debug({ sig }, "received signal");
        await runHandlers("signal");
        process.exit(0);
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
}

export function onShutdown(handler: ShutdownHandler): void {
    installSignals();
    handlers.push(handler);
}

export async function triggerShutdown(reason: ShutdownReason): Promise<void> {
    await runHandlers(reason);
}
