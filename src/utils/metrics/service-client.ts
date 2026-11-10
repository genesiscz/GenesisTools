import { logger } from "@genesiscz/utils/logger";
import type { RpcRequestOptions } from "@genesiscz/utils/rpc/peer";
import { launchService, readLiveServiceEntry, type ServiceEntry } from "@genesiscz/utils/rpc/service-host";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import {
    eventNotificationSchema,
    METRICS_EVENT,
    METRICS_PROTOCOL,
    type MetricsEventNotification,
    type MetricsMethod,
    type MetricsParams,
    type MetricsResult,
} from "./protocol";
import { metricsServiceDir } from "./spool";

const { log } = logger.scoped("metrics-client");

/** A connection to the running metrics service. */
export class MetricsServiceClient {
    private constructor(
        readonly socket: RpcSocketClient,
        readonly entry: ServiceEntry
    ) {}

    /** Connects to the service `dir` names; throws when its socket does not answer. */
    static async connect(entry: ServiceEntry): Promise<MetricsServiceClient> {
        const socket = await RpcSocketClient.connect({
            socket: entry.socket,
            logScope: "metrics-client",
            label: "metrics service",
            defaultTimeoutMs: 120_000,
        });
        return new MetricsServiceClient(socket, entry);
    }

    call<M extends MetricsMethod>(
        method: M,
        params: MetricsParams<M>,
        options?: RpcRequestOptions
    ): Promise<MetricsResult<M>> {
        return this.socket.call<MetricsResult<M>>(method, params, options);
    }

    /** Hears the events the service takes in, of one project and metric when given, until the function it returns. */
    async subscribe(
        filter: { project?: string; metric?: string },
        listener: (event: MetricsEventNotification) => void
    ): Promise<() => void> {
        const stop = this.socket.onNotification((notification) => {
            if (notification.method !== METRICS_EVENT) {
                return;
            }

            const parsed = eventNotificationSchema.safeParse(notification.params);

            if (parsed.success) {
                listener(parsed.data);
            } else {
                log.debug({ issue: parsed.error.issues[0] }, "a metrics event notification does not read");
            }
        });
        await this.socket.call("subscribe", { events: [METRICS_EVENT], ...filter });
        return stop;
    }

    close(): void {
        this.socket.close();
    }
}

export type MetricsServiceOpen =
    | { status: "connected"; client: MetricsServiceClient }
    | { status: "none"; reason: string };

/**
 * The client a command uses. `start: true` starts the service in its own process when none runs (`query`, `events`,
 * `tail`, `connect`); `start: false` only connects to a running one (the diagnostics `list` and `status`).
 */
export async function openMetricsService(options: { start: boolean; dir?: string }): Promise<MetricsServiceOpen> {
    const dir = options.dir ?? metricsServiceDir();
    let entry = readLiveServiceEntry(dir);

    if (entry && entry.protocol !== METRICS_PROTOCOL) {
        return {
            status: "none",
            reason: `the metrics service speaks protocol ${entry.protocol}, not ${METRICS_PROTOCOL}`,
        };
    }

    if (!entry && options.start) {
        const launch = await launchService({
            dir,
            command: ["metrics", "serve"],
            gates: toolDataDir("metrics", "start-gates"),
            label: "metrics service",
            logScope: "metrics-service",
        });

        if (launch.status === "failed") {
            return { status: "none", reason: launch.reason };
        }

        entry = launch.entry;
    }

    if (!entry) {
        return { status: "none", reason: `no metrics service runs (${dir}/service.json names no live process)` };
    }

    try {
        return { status: "connected", client: await MetricsServiceClient.connect(entry) };
    } catch (error) {
        log.debug({ error, socket: entry.socket }, "the metrics service socket did not answer");
        return { status: "none", reason: `the metrics service (pid ${entry.pid}) did not answer on ${entry.socket}` };
    }
}
