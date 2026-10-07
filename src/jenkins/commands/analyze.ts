import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { getJenkinsBackend } from "../lib/rest/client";
import { fetchBuildInfo } from "../lib/rest/track-pipeline";
import type { JenkinsBuild } from "../lib/rest/types";
import { analyzeUrl, formatAnalysisOutput, isJenkinsTarget, parseBuildUrl } from "../lib/rest/url-analyzer";

export { isJenkinsTarget };

/** `jenkins <url>`: what the build is and which command to run next. Without credentials it still analyzes the URL. */
export async function runSmartUrlMode(input: string): Promise<void> {
    const parsed = parseBuildUrl(input);

    if (!parsed) {
        throw new Error(
            `Could not parse Jenkins URL: ${input}\nExpected https://<jenkins>/job/<folder>/job/<job>/<build>/ or job/<folder>/job/<job>`
        );
    }

    let build: JenkinsBuild | null = null;

    if (parsed.buildNumber) {
        try {
            build = await fetchBuildInfo(await getJenkinsBackend(), parsed.jobPath, parsed.buildNumber);
        } catch (error) {
            out.error(
                pc.yellow(`# Warning: no live build data (${error instanceof Error ? error.message : String(error)})`)
            );
        }
    }

    const analysis = analyzeUrl(input, build);

    if (!analysis) {
        throw new Error(`Could not analyze URL: ${input}`);
    }

    out.println(formatAnalysisOutput(analysis));
}
