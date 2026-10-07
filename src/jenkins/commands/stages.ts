import type { Command } from "commander";
import { getJenkinsBackend } from "../lib/rest/client";
import { resolveJobAndBuild } from "./helpers";

/** `stages <job-or-url> [build]`: the `mcp stages` view, with the build as an argument (default: the last build). */
export function registerStages(jenkins: Command): void {
    jenkins
        .command("stages")
        .description("Stage timings for a build (same view as `mcp stages`)")
        .argument("<job-or-url>", "Jenkins job URL or path")
        .argument("[build]", "Build number (default: the build in the URL, else lastBuild)")
        .option("--expand", "Show parallel branches inside each stage")
        .action(async (jobOrUrl: string, build: string | undefined, opts: { expand?: boolean }) => {
            const { jobPath, buildNumber } = resolveJobAndBuild(jobOrUrl, build);
            const { resolveBuildNumber } = await import("../lib/mcp/log");
            const pinned = await resolveBuildNumber((await getJenkinsBackend()).client, jobPath, buildNumber);
            const { runCli } = await import("../lib/mcp/cli");
            await runCli(["stages", jobPath, "--build", pinned, ...(opts.expand ? ["--expand"] : [])]);
        });
}
