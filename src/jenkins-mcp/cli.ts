import { enhanceHelp } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { Command } from "commander";
import { createClient, readEnvAuth } from "./lib/client";
import { fetchLog, readLogPreview } from "./lib/log";
import { exitCodeFor, runMonitor } from "./lib/monitor";
import { MonitorNotifier } from "./lib/notify";
import { type FlowNode, getStages, type Stage } from "./lib/pipeline";
import { formatStageLine } from "./lib/format";
import { parseJenkinsInput } from "./lib/url";

function resolveRef(input: string, buildFlag?: string, nodeFlag?: string) {
    const ref = parseJenkinsInput(input);
    return {
        jobPath: ref.jobPath,
        buildNumber: buildFlag ?? ref.buildNumber,
        nodeId: nodeFlag ?? ref.nodeId,
    };
}

function parseDuration(s: string): number {
    const m = s.match(/^(\d+)\s*(s|m|h)?$/);

    if (!m) {
        throw new Error(`Bad duration: ${s} (expected like 30s, 10m, 2h)`);
    }

    const n = Number.parseInt(m[1], 10);
    const unit = (m[2] ?? "s") as "s" | "m" | "h";
    const mult = { s: 1000, m: 60_000, h: 3_600_000 }[unit];
    return n * mult;
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
            const ref = resolveRef(input, opts.build);

            if (!ref.buildNumber) {
                throw new Error("Need --build or URL with build number");
            }

            const snap = await getStages(createClient(readEnvAuth()), ref.jobPath, ref.buildNumber, {
                expand: opts.expand,
            });
            console.log(`Build ${ref.buildNumber} — ${snap.status}`);

            for (const stage of snap.stages as Stage[]) {
                console.log(`  ${formatStageLine(stage)}`);

                if (opts.expand) {
                    for (const branch of (stage.stageFlowNodes ?? []) as FlowNode[]) {
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
                const ref = resolveRef(input, opts.build, opts.node);

                if (!ref.buildNumber) {
                    throw new Error("Need --build or URL with build number");
                }

                const r = await fetchLog(createClient(readEnvAuth()), ref.jobPath, ref.buildNumber, {
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
            const ref = resolveRef(input, opts.build);
            const tree =
                "number,result,building,duration,timestamp,builtOn,estimatedDuration,executor[*],actions[parameters[name,value],causes[shortDescription,userId]]";
            const res = await createClient(readEnvAuth()).get(
                `/${ref.jobPath}/${ref.buildNumber ?? "lastBuild"}/api/json?tree=${tree}`
            );
            console.log(SafeJSON.stringify(res.data, null, 2));
        });

    program
        .command("changes <input>")
        .description("Commits + trigger causes for a build")
        .option("--build <n>", "Build number")
        .action(async (input: string, opts: { build?: string }) => {
            const ref = resolveRef(input, opts.build);
            const tree =
                "changeSet[items[commitId,author[fullName],msg,timestamp]],actions[causes[shortDescription,userId]]";
            const res = await createClient(readEnvAuth()).get(
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
            const res = await createClient(readEnvAuth()).get(path);
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
                const ref = resolveRef(input, opts.build);
                const auth = readEnvAuth();
                const client = createClient(auth);
                const notifier = opts.notify === false ? undefined : new MonitorNotifier();
                const out = opts.quiet ? () => {} : (line: string) => process.stdout.write(line);
                const result = await runMonitor({
                    client,
                    jobPath: ref.jobPath,
                    build: ref.buildNumber!,
                    baseUrl: auth.url,
                    timeoutMs: parseDuration(opts.timeout),
                    pollMs: parseDuration(opts.poll),
                    notifier,
                    out,
                });
                notifier?.close();
                process.exit(exitCodeFor(result.result, result.timedOut));
            }
        );

    enhanceHelp(program);
    await program.parseAsync(argv, { from: "user" });
}
