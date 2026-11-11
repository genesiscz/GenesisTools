import { mkdirSync } from "node:fs";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { awaitStart, startGatePath, stopPassedChild, sweepStartGates } from "@genesiscz/utils/process/start-gate";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { readLiveService, type ServiceEntry } from "./service-protocol";

const { log } = logger.scoped("recorder-service");

/** How long a start waits for the service to listen; the app's host waits 20 s for the socket. */
const START_TIMEOUT_MS = 15_000;
const START_GRACE_MS = 5_000;
const START_GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A start of the recorder service: it ran already, it started, or why it did not. */
export type ServiceLaunch =
    | { status: "running" | "started"; entry: ServiceEntry }
    | { status: "failed"; reason: string };

/**
 * Starts `tools recorder serve` in its own process and waits for its service.json; a running service is answered
 * as it is. `tools recorder serve --detach` and a caller that needs the app's host (the camera) both start it here.
 */
export async function launchRecorderService(): Promise<ServiceLaunch> {
    const running = readLiveService();

    if (running) {
        return { status: "running", entry: running };
    }

    const gates = toolDataDir("recorder", "start-gates");
    mkdirSync(gates, { recursive: true });
    sweepStartGates(gates, START_GATE_MAX_AGE_MS);
    const gate = startGatePath(gates);
    const startedAt = Date.now();
    log.info({ gate }, "starting the recorder service");
    spawnToolDetached(["recorder", "serve", "--start-gate", gate], { reparent: true });
    const outcome = await awaitStart({
        gate,
        find: () => readLiveService(),
        timeoutMs: START_TIMEOUT_MS,
        graceMs: START_GRACE_MS,
        pollMs: 200,
        stop: (pid) => {
            stopPassedChild({
                gate,
                pid,
                signal: (target) => {
                    log.warn({ pid: target, gate }, "the recorder service passed its start but never listened");
                    // pid-verified: stopPassedChild calls this only after inspectPidFile confirmed the gate's writer is this live process
                    process.kill(target, "SIGTERM");
                },
            });
        },
    });

    if (outcome.status === "started") {
        log.info({ pid: outcome.value.pid, ms: Date.now() - startedAt }, "the recorder service started");
        return { status: "started", entry: outcome.value };
    }

    const reason = `the recorder service did not start within ${(START_TIMEOUT_MS + START_GRACE_MS) / 1000} s (${outcome.status}); run ${toolCommand("recorder serve")} in a terminal to see why`;
    log.warn({ status: outcome.status, ms: Date.now() - startedAt }, reason);
    return { status: "failed", reason };
}
