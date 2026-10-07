import type { Command } from "commander";
import { getJenkinsBackend } from "../lib/rest/client";
import { rebuild } from "../lib/rest/rebuild";
import { positiveInt } from "./helpers";

export function registerRebuild(jenkins: Command): void {
    jenkins
        .command("rebuild")
        .description("Rerun a build with the same parameters (target = job path or full URL)")
        .argument("<target>", "Job path or full Jenkins build URL")
        .argument("[build-number]", "Build number or latest (required with a job path)")
        .option("--no-wait", "Do not wait for the queue item to become a build")
        .option("--dry-run", "Fetch and print params without triggering")
        .action(async (target: string, buildNumber: string | undefined, opts: { wait: boolean; dryRun?: boolean }) => {
            const options = { wait: opts.wait, dryRun: opts.dryRun };
            const backend = await getJenkinsBackend();

            if (/^https?:\/\//.test(target)) {
                await rebuild(backend, { url: target }, options);
                return;
            }

            if (!buildNumber) {
                throw new Error(
                    "A build number is required when the target is a job path: rebuild <job-path> <n|latest>"
                );
            }

            const parsed = buildNumber === "latest" ? "latest" : positiveInt(buildNumber);

            if (parsed === null) {
                throw new Error(`Invalid build number: ${buildNumber} (a whole number of 1 or more, or latest)`);
            }

            await rebuild(backend, { jobPath: target, buildNumber: parsed }, options);
        });
}
