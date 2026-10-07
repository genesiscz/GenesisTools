import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseJenkinsInput } from "../lib/mcp/url";
import { getJenkinsBackend, type JenkinsBackend } from "../lib/rest/client";
import { deriveQueueApiUrl, triggerAccepted } from "../lib/rest/rebuild";
import { positiveInt } from "./helpers";

const QUEUE_WAIT_MS = 120_000;
const QUEUE_POLL_MS = 2000;

export interface TriggersOptions {
    backend?: JenkinsBackend;
    queueWaitMs?: number;
    pollMs?: number;
}

/**
 * Jenkins merges identical queue items, so each POST waits for its item to become a build before the
 * next. An item that does not become a build in time, was cancelled, or has no queue location stops
 * the run with exit code 1: another POST would merge into it and the count would be wrong.
 */
export async function cmdTriggers(jobPath: string, count: number, options: TriggersOptions = {}): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error(`triggers needs a count of 1 or more, got ${count}`);
    }

    const backend = options.backend ?? (await getJenkinsBackend());
    const queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    const pollMs = options.pollMs ?? QUEUE_POLL_MS;

    for (let i = 1; i <= count; i++) {
        const res = await backend.post(`${jobPath}/build`);

        if (!triggerAccepted(res)) {
            out.println(`triggered ${i - 1}/${count}: request ${i} was refused (HTTP ${res.status}), aborting`);
            process.exitCode = 1;
            return;
        }

        let buildNumber: number | null = null;
        let cancelled = false;

        if (res.location) {
            const deadline = Date.now() + queueWaitMs;

            while (Date.now() < deadline) {
                const item = await backend.apiOrNull<{ executable?: { number?: number }; cancelled?: boolean }>(
                    deriveQueueApiUrl(res.location)
                );

                if (item?.executable?.number) {
                    buildNumber = item.executable.number;
                    break;
                }

                if (item?.cancelled) {
                    cancelled = true;
                    break;
                }

                await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
            }
        }

        if (buildNumber) {
            out.println(`triggered ${i}/${count} -> #${buildNumber}`);
            continue;
        }

        const why = cancelled
            ? "its queue item was cancelled"
            : res.location
              ? `no build yet after ${Math.round(queueWaitMs / 1000)}s`
              : "Jenkins gave no queue location";

        if (cancelled || i < count) {
            out.println(`triggered ${i}/${count}: ${why}, stopping so the next request is not merged into it`);
            process.exitCode = 1;
            return;
        }

        out.println(`triggered ${i}/${count} (queued: ${why})`);
    }
}

export function registerTriggers(jenkins: Command): void {
    jenkins
        .command("triggers")
        .description("Trigger N builds (default 1); waits for queue->build between each")
        .argument("<job-or-url>", "Jenkins job URL or path")
        .option("-n, --count <n>", "Number of builds to trigger", "1")
        .action(async (jobOrUrl: string, options: { count: string }) => {
            const count = positiveInt(options.count);

            if (count === null) {
                throw new Error(`--count must be a whole number of 1 or more, got "${options.count}"`);
            }

            await cmdTriggers(parseJenkinsInput(jobOrUrl).jobPath, count);
        });
}
