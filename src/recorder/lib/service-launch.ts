import { launchService } from "@genesiscz/utils/rpc/service-host";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { recorderServiceDir, type ServiceEntry } from "./service-protocol";

/** A start of the recorder service: it ran already, it started, or why it did not. */
export type ServiceLaunch =
    | { status: "running" | "started"; entry: ServiceEntry }
    | { status: "failed"; reason: string };

/**
 * Starts `tools recorder serve` in its own process and waits for its service.json; a running service is answered
 * as it is. `tools recorder serve --detach` and a caller that needs the app's host (the camera) both start it here.
 * The start itself is the shared host's (`launchService`); the app's host waits 20 s for the socket, and the start
 * waits 15 s plus a 5 s grace.
 */
export function launchRecorderService(): Promise<ServiceLaunch> {
    return launchService({
        dir: recorderServiceDir(),
        command: ["recorder", "serve"],
        gates: toolDataDir("recorder", "start-gates"),
        label: "recorder service",
        logScope: "recorder-service",
    });
}
