import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseJenkinsInput } from "../lib/mcp/url";
import { getJenkinsBackend } from "../lib/rest/client";
import { deriveQueueApiUrl } from "../lib/rest/rebuild";

const QUEUE_WAIT_MS = 120_000;

/** Jenkins merges identical queue items, so each POST waits for its item to become a build before the next. */
export async function cmdTriggers(jobPath: string, count: number): Promise<void> {
    const backend = await getJenkinsBackend();

    for (let i = 1; i <= count; i++) {
        const res = await backend.post(`${jobPath}/build`);

        if (res.status !== 201 && res.status !== 302) {
            out.println(`triggered ${i}/${count} (HTTP ${res.status}), aborting`);
            return;
        }

        let buildNumber: number | null = null;

        if (res.location) {
            const deadline = Date.now() + QUEUE_WAIT_MS;

            while (Date.now() < deadline) {
                const item = await backend.apiOrNull<{ executable?: { number?: number }; cancelled?: boolean }>(
                    deriveQueueApiUrl(res.location)
                );

                if (item?.executable?.number) {
                    buildNumber = item.executable.number;
                    break;
                }

                if (item?.cancelled) {
                    break;
                }

                await Bun.sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
            }
        }

        out.println(
            `triggered ${i}/${count}${buildNumber ? ` -> #${buildNumber}` : " (queued, no build yet after 120s)"}`
        );
    }
}

export function registerTriggers(jenkins: Command): void {
    jenkins
        .command("triggers")
        .description("Trigger N builds (default 1); waits for queue->build between each")
        .argument("<job-or-url>", "Jenkins job URL or path")
        .option("-n, --count <n>", "Number of builds to trigger", "1")
        .action(async (jobOrUrl: string, options: { count: string }) => {
            const count = Number.parseInt(options.count, 10) || 1;
            await cmdTriggers(parseJenkinsInput(jobOrUrl).jobPath, count);
        });
}
