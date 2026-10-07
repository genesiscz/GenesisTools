import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseJenkinsInput } from "../lib/mcp/url";
import { getJenkinsBackend } from "../lib/rest/client";
import { parseBuildRange } from "./helpers";

export async function cmdStopRange(jobPath: string, from: number, to: number): Promise<void> {
    const backend = await getJenkinsBackend();

    for (let n = from; n <= to; n++) {
        const { status } = await backend.post(`${jobPath}/${n}/stop`);
        const ok = status === 200 || status === 302;
        out.println(`#${n}: stop -> HTTP ${status}${ok ? "" : " (not running?)"}`);
    }
}

export function registerStopRange(jenkins: Command): void {
    jenkins
        .command("stop-range")
        .description("Stop a range of builds")
        .argument("<job-or-url>", "Jenkins job URL or path")
        .argument("<from>", "First build number")
        .argument("<to>", "Last build number")
        .action(async (jobOrUrl: string, fromArg: string, toArg: string) => {
            const { from, to } = parseBuildRange(fromArg, toArg, "stop-range");
            await cmdStopRange(parseJenkinsInput(jobOrUrl).jobPath, from, to);
        });
}
