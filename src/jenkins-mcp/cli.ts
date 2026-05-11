import { enhanceHelp } from "@app/utils/cli";
import { parseDuration as parseDurationUtil } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import type { AxiosInstance } from "axios";
import { Command } from "commander";
import { createClient, type JenkinsAuth, readEnvAuth } from "./lib/client";
import { formatStageLine } from "./lib/format";
import { fetchLog, readLogPreview } from "./lib/log";
import { exitCodeFor, runMonitor } from "./lib/monitor";
import { MonitorNotifier } from "./lib/notify";
import { getStages } from "./lib/pipeline";
import { resolveRef } from "./lib/url";

let cachedAuth: JenkinsAuth | null = null;
let cachedClient: AxiosInstance | null = null;

function loadClient(): AxiosInstance {
    if (!cachedClient) {
        cachedAuth ??= readEnvAuth();
        cachedClient = createClient(cachedAuth);
    }

    return cachedClient;
}

function loadAuth(): JenkinsAuth {
    cachedAuth ??= readEnvAuth();
    return cachedAuth;
}

function parseDuration(s: string): number {
    const ms = parseDurationUtil(s);

    if (ms === 0 && s.trim() !== "0") {
        throw new Error(`Bad duration: ${s} (expected like 30s, 10m, 2h, or 1h30m)`);
    }

    return ms;
}

export async function runCli(argv: string[]): Promise<void> {
    const program = new Command()
        .name("tools jenkins-mcp")
        .description("Jenkins CLI — paste a job path or full Jenkins URL");

    program
        .command("stages <input>")
        .description("Show pipeline stage tree for a build")
        .option("--build <n>", "Build number (or use URL with /<build>/)")
        .option("--expand", "Show parallel branches inside each stage")
        .action(async (input: string, opts: { build?: string; expand?: boolean }) => {
            const ref = resolveRef({ input, buildOverride: opts.build });

            if (!ref.buildNumber) {
                throw new Error("Need --build or URL with build number");
            }

            const snap = await getStages(loadClient(), ref.jobPath, ref.buildNumber, {
                expand: opts.expand,
            });
            console.log(`Build ${ref.buildNumber} — ${snap.status}`);

            for (const stage of snap.stages) {
                console.log(`  ${formatStageLine(stage)}`);

                if (opts.expand) {
                    for (const branch of stage.stageFlowNodes ?? []) {
                        console.log(`    ├ ${formatStageLine(branch)}`);
                    }
                }
            }
        });

    program
        .command("log <input>")
        .description("Fetch build (or single node) log to /tmp/jenkins-mcp/, print preview")
        .option("--build <n>", "Build number")
        .option("--node <id>", "Node id (selected-node)")
        .option("--tail <n>", "Show last N lines", (v) => Number.parseInt(v, 10), 20)
        .option("--head <n>", "Show first N lines", (v) => Number.parseInt(v, 10))
        .option("--grep <pattern>", "Regex to filter lines")
        .action(
            async (
                input: string,
                opts: { build?: string; node?: string; tail?: number; head?: number; grep?: string }
            ) => {
                const ref = resolveRef({ input, buildOverride: opts.build, nodeOverride: opts.node });

                if (!ref.buildNumber) {
                    throw new Error("Need --build or URL with build number");
                }

                const r = await fetchLog(loadClient(), ref.jobPath, ref.buildNumber, {
                    nodeId: ref.nodeId,
                });
                console.log(
                    `saved: ${r.path} (${r.sizeBytes}B, ${r.lineCount} lines${
                        r.nodeStatus ? `, status=${r.nodeStatus}` : ""
                    }${r.truncated ? ", TRUNCATED" : ""})`
                );
                const preview = await readLogPreview(r.path, {
                    tail: opts.tail,
                    head: opts.head,
                    grep: opts.grep,
                });

                if (opts.head !== undefined) {
                    console.log(`--- head (${preview.first.length}) ---`);
                    console.log(preview.first.join("\n"));
                }

                if (opts.grep) {
                    console.log(`--- grep (${preview.grepMatches?.length ?? 0} matches) ---`);
                    console.log(preview.grepMatches?.map((m) => `${m.line}: ${m.text}`).join("\n") ?? "");
                }

                console.log(`--- tail (${preview.last.length}) ---`);
                console.log(preview.last.join("\n"));
            }
        );

    program
        .command("info <input>")
        .description("Build summary: status + params + causes + agent")
        .option("--build <n>", "Build number")
        .action(async (input: string, opts: { build?: string }) => {
            const ref = resolveRef({ input, buildOverride: opts.build });
            const tree =
                "number,result,building,duration,timestamp,builtOn,estimatedDuration,executor[*],actions[parameters[name,value],causes[shortDescription,userId]]";
            const res = await loadClient().get(
                `/${ref.jobPath}/${ref.buildNumber ?? "lastBuild"}/api/json?tree=${tree}`
            );
            console.log(SafeJSON.stringify(res.data, null, 2));
        });

    program
        .command("changes <input>")
        .description("Commits + trigger causes for a build")
        .option("--build <n>", "Build number")
        .action(async (input: string, opts: { build?: string }) => {
            const ref = resolveRef({ input, buildOverride: opts.build });
            const tree =
                "changeSet[items[commitId,author[fullName],msg,timestamp]],actions[causes[shortDescription,userId]]";
            const res = await loadClient().get(
                `/${ref.jobPath}/${ref.buildNumber ?? "lastBuild"}/api/json?tree=${tree}`
            );
            console.log(SafeJSON.stringify(res.data, null, 2));
        });

    program
        .command("jobs")
        .description("List jobs in a folder")
        .option("--folder <path>", "Folder path (e.g. job/Foo/job/Bar)")
        .option("--limit <n>", "Max jobs to print", (v) => Number.parseInt(v, 10))
        .action(async (opts: { folder?: string; limit?: number }) => {
            const path = opts.folder ? `/${opts.folder}/api/json` : "/api/json";
            const res = await loadClient().get(path);
            const all = (res.data.jobs ?? []) as Array<{ name: string; color: string; url: string }>;
            const limited = opts.limit !== undefined ? all.slice(0, opts.limit) : all;

            for (const j of limited) {
                console.log(`${j.name}\t${j.color}\t${j.url}`);
            }
        });

    program
        .command("monitor <input>")
        .description("Stream pipeline stage events to stdout (JSONL), notify on transitions")
        .requiredOption("--build <n>", "Build number")
        .option("--timeout <duration>", "Max wait (30s, 10m, 2h)", "30m")
        .option("--poll <duration>", "Poll interval (default 5s)", "5s")
        .option("--no-notify", "Disable terminal notifications")
        .option("--quiet", "Suppress JSONL output (exit code only)")
        .action(
            async (
                input: string,
                opts: {
                    build: string;
                    timeout: string;
                    poll: string;
                    notify: boolean;
                    quiet?: boolean;
                }
            ) => {
                const ref = resolveRef({ input, buildOverride: opts.build });
                const notifier = opts.notify === false ? undefined : new MonitorNotifier();
                const out = opts.quiet ? () => {} : (line: string) => process.stdout.write(line);
                const result = await runMonitor({
                    client: loadClient(),
                    jobPath: ref.jobPath,
                    build: ref.buildNumber!,
                    baseUrl: loadAuth().url,
                    timeoutMs: parseDuration(opts.timeout),
                    pollMs: parseDuration(opts.poll),
                    notifier,
                    out,
                });
                process.exit(exitCodeFor(result.result, result.timedOut));
            }
        );

    enhanceHelp(program);
    await program.parseAsync(argv, { from: "user" });
}
