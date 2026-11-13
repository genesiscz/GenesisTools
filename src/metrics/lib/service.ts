import { out } from "@genesiscz/utils/logger";
import { type MetricsServiceClient, openMetricsService } from "@genesiscz/utils/metrics/service-client";
import { FlagError } from "./filters";

/**
 * Runs `work` with a connection to the metrics service, started when none runs, and closes it. A refused flag or a
 * service that cannot start prints its reason and sets exit code 1.
 */
export async function withService(work: (client: MetricsServiceClient) => Promise<void>): Promise<void> {
    const opened = await openMetricsService({ start: true });

    if (opened.status === "none") {
        out.printlnErr(opened.reason);
        process.exitCode = 1;
        return;
    }

    try {
        await work(opened.client);
    } catch (error) {
        out.printlnErr(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    } finally {
        opened.client.close();
    }
}

/** Runs a command body; a `FlagError` prints its message and sets exit code 1. */
export async function withFlags(work: () => Promise<void>): Promise<void> {
    try {
        await work();
    } catch (error) {
        if (!(error instanceof FlagError)) {
            throw error;
        }

        out.printlnErr(error.message);
        process.exitCode = 1;
    }
}
