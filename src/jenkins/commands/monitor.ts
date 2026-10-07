import type { Command } from "commander";
import { getJenkinsBackend } from "../lib/rest/client";
import { resolveJobAndBuild } from "./helpers";

interface MonitorOptions {
    timeout: string;
    poll: string;
    notify: boolean;
    quiet?: boolean;
    detail?: boolean;
}

/** `monitor <job-or-url> [build]`: `mcp monitor` with the build as an argument; `lastBuild` is pinned to its number first. */
export function registerMonitor(jenkins: Command): void {
    jenkins
        .command("monitor")
        .description("Stream a build until it ends: one line per stage result and error, a notification per change")
        .argument("<job-or-url>", "Jenkins job URL or path")
        .argument("[build]", "Build number (default: the build in the URL, else lastBuild)")
        .option("--timeout <duration>", "Max wait (30s, 10m, 2h)", "30m")
        .option("--poll <duration>", "Poll interval", "5s")
        .option("--no-notify", "Disable notifications")
        .option("--quiet", "Suppress output (exit code only)")
        .option("--detail", "Every event as JSONL")
        .action(async (jobOrUrl: string, build: string | undefined, opts: MonitorOptions) => {
            const backend = await getJenkinsBackend();
            const { jobPath, buildNumber } = resolveJobAndBuild({
                jobOrUrl,
                buildArg: build,
                baseUrl: backend.baseUrl,
            });
            const { resolveBuildNumber } = await import("../lib/mcp/log");
            const pinned = await resolveBuildNumber(backend.client, jobPath, buildNumber);

            const { runCli } = await import("../lib/mcp/cli");
            await runCli([
                "monitor",
                jobPath,
                "--build",
                pinned,
                "--timeout",
                opts.timeout,
                "--poll",
                opts.poll,
                ...(opts.notify === false ? ["--no-notify"] : []),
                ...(opts.quiet ? ["--quiet"] : []),
                ...(opts.detail ? ["--detail"] : []),
            ]);
        });
}
