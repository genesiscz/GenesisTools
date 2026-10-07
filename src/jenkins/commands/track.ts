import type { Command } from "commander";
import { parseJenkinsInput } from "../lib/mcp/url";
import { getJenkinsBackend } from "../lib/rest/client";
import { trackPipeline } from "../lib/rest/track-pipeline";

export function registerTrack(jenkins: Command): void {
    jenkins
        .command("track")
        .description("Track a pipeline: the build, then the downstream builds it triggers (see lib/rest/catalog.ts)")
        .argument("<job-or-url>", "Jenkins job path or build URL")
        .argument("[build-number]", "Build number or latest (default: the build in the URL, else latest)")
        .action(async (jobOrUrl: string, buildArg: string | undefined) => {
            const ref = parseJenkinsInput(jobOrUrl);
            const raw = buildArg ?? ref.buildNumber ?? "latest";
            const buildNumber = raw === "latest" ? "latest" : Number.parseInt(raw, 10);

            if (buildNumber !== "latest" && Number.isNaN(buildNumber)) {
                throw new Error(`Invalid build number: ${raw}`);
            }

            const result = await trackPipeline(await getJenkinsBackend(), ref.jobPath, buildNumber);

            if (!result.allPassed) {
                process.exitCode = 1;
            }
        });
}
