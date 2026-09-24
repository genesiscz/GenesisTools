import { enhanceHelp } from "@genesiscz/utils/cli";
import { parseDuration as parseDurationUtil } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { AxiosInstance } from "axios";
import { Command } from "commander";
import { createClient } from "./lib/client";
import { type JenkinsAuth, JenkinsAuthMissingError, resolveAuth } from "./lib/credentials";
import { formatStageLine } from "./lib/format";
import { fetchLog, grepLog } from "./lib/log";
import { runAuthStatus, runLogin, runLogout } from "./lib/login";
import { exitCodeFor, runMonitor } from "./lib/monitor";
import { MonitorNotifier } from "./lib/notify";
import { getStages } from "./lib/pipeline";
import { resolveRef } from "./lib/url";

let cachedAuth: JenkinsAuth | null = null;
let cachedClient: AxiosInstance | null = null;

async function loadAuth(): Promise<JenkinsAuth> {
    cachedAuth ??= await resolveAuth();
    return cachedAuth;
}

async function loadClient(): Promise<AxiosInstance> {
    cachedClient ??= createClient(await loadAuth());
    return cachedClient;
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

            const snap = await getStages(await loadClient(), ref.jobPath, ref.buildNumber, {
                expand: opts.expand,
            });
            out.println(`Build ${ref.buildNumber} — ${snap.status}`);

            for (const stage of snap.stages) {
                out.println(`  ${formatStageLine(stage)}`);

                if (opts.expand) {
                    for (const branch of stage.stageFlowNodes ?? []) {
                        out.println(`    ├ ${formatStageLine(branch)}`);
                    }
                }
            }
        });

    program
        .command("log <input>")
        .description("Fetch build (or single node) log to $TMPDIR/jenkins-mcp/, print preview")
        .option("--build <n>", "Build number")
        .option("--node <id>", "Node id (selected-node)")
        .option("--tail <n>", "Show last N lines (default 20, none with --grep or --head)", (v) =>
            Number.parseInt(v, 10)
        )
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

                const r = await fetchLog(await loadClient(), ref.jobPath, ref.buildNumber, {
                    nodeId: ref.nodeId,
                });
                out.println(
                    `saved: ${r.path} (${r.sizeBytes}B, ${r.lineCount} lines${
                        r.nodeStatus ? `, status=${r.nodeStatus}` : ""
                    }${r.truncated ? ", TRUNCATED" : ""})`
                );

                const lines = r.content.split("\n");

                if (lines.at(-1) === "") {
                    lines.pop();
                }

                if (opts.head !== undefined) {
                    const first = lines.slice(0, opts.head);
                    out.println(`--- head (${first.length}) ---`);
                    out.println(first.join("\n"));
                }

                if (opts.grep) {
                    const matches = grepLog(r.content, opts.grep);
                    out.println(`--- grep (${matches.length} matches) ---`);
                    out.println(matches.join("\n"));
                }

                const tailN = opts.tail ?? (opts.grep || opts.head !== undefined ? 0 : 20);

                if (tailN > 0) {
                    const last = lines.slice(-tailN);
                    out.println(`--- tail (${last.length}) ---`);
                    out.println(last.join("\n"));
                }
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
            const res = await (await loadClient()).get(
                `/${ref.jobPath}/${ref.buildNumber ?? "lastBuild"}/api/json?tree=${tree}`
            );
            out.println(SafeJSON.stringify(res.data, null, 2));
        });

    program
        .command("changes <input>")
        .description("Commits + trigger causes for a build")
        .option("--build <n>", "Build number")
        .action(async (input: string, opts: { build?: string }) => {
            const ref = resolveRef({ input, buildOverride: opts.build });
            const tree =
                "changeSet[items[commitId,author[fullName],msg,timestamp]],actions[causes[shortDescription,userId]]";
            const res = await (await loadClient()).get(
                `/${ref.jobPath}/${ref.buildNumber ?? "lastBuild"}/api/json?tree=${tree}`
            );
            out.println(SafeJSON.stringify(res.data, null, 2));
        });

    program
        .command("jobs")
        .description("List jobs in a folder")
        .option("--folder <path>", "Folder path (e.g. job/Foo/job/Bar)")
        .option("--limit <n>", "Max jobs to print", (v) => Number.parseInt(v, 10))
        .action(async (opts: { folder?: string; limit?: number }) => {
            const path = opts.folder ? `/${opts.folder}/api/json` : "/api/json";
            const res = await (await loadClient()).get(path);
            const all = (res.data.jobs ?? []) as Array<{ name: string; color: string; url: string }>;
            const limited = opts.limit !== undefined ? all.slice(0, opts.limit) : all;

            for (const j of limited) {
                out.println(`${j.name}\t${j.color}\t${j.url}`);
            }
        });

    program
        .command("monitor <input>")
        .description("Stream pipeline stage events to stdout (JSONL), notify on transitions")
        .option("--build <n>", "Build number (or use URL with /<build>/)")
        .option("--timeout <duration>", "Max wait (30s, 10m, 2h)", "30m")
        .option("--poll <duration>", "Poll interval (default 5s)", "5s")
        .option("--no-notify", "Disable terminal notifications")
        .option("--quiet", "Suppress JSONL output (exit code only)")
        .action(
            async (
                input: string,
                opts: {
                    build?: string;
                    timeout: string;
                    poll: string;
                    notify: boolean;
                    quiet?: boolean;
                }
            ) => {
                const ref = resolveRef({ input, buildOverride: opts.build });

                if (!ref.buildNumber) {
                    throw new Error("Need --build or URL with build number");
                }

                const notifier = opts.notify === false ? undefined : new MonitorNotifier();
                const out = opts.quiet ? () => {} : (line: string) => process.stdout.write(line);
                const result = await runMonitor({
                    client: await loadClient(),
                    jobPath: ref.jobPath,
                    build: ref.buildNumber,
                    baseUrl: (await loadAuth()).url,
                    timeoutMs: parseDuration(opts.timeout),
                    pollMs: parseDuration(opts.poll),
                    notifier,
                    out,
                });
                process.exit(exitCodeFor(result.result, result.timedOut));
            }
        );

    program
        .command("login")
        .description("Create and store a Jenkins API token (opens <jenkins>/me/security/)")
        .option("--url <url>", "Jenkins base URL — skips the prompt")
        .option("--user <name>", "Jenkins username — skips the prompt")
        .option("--token <token>", "API token — skips the prompt and the browser")
        .option("--no-open", "Print the token page URL instead of opening a browser")
        .action(async (opts: { url?: string; user?: string; token?: string; open?: boolean }) => {
            process.exit(
                await runLogin({
                    url: opts.url,
                    user: opts.user,
                    token: opts.token,
                    noOpen: opts.open === false,
                })
            );
        });

    program
        .command("logout")
        .description("Remove the stored Jenkins token")
        .option("--url <url>", "Which Jenkins to forget (default: the stored one)")
        .action(async (opts: { url?: string }) => {
            process.exit(await runLogout(opts.url));
        });

    program
        .command("status")
        .description("Show which credentials are in use and who they authenticate as")
        .action(async () => {
            process.exit(await runAuthStatus());
        });

    enhanceHelp(program);

    try {
        await program.parseAsync(argv, { from: "user" });
    } catch (error) {
        // The setup message is the whole value here; a stack trace is not.
        if (error instanceof JenkinsAuthMissingError) {
            out.error(error.message);
            process.exit(1);
        }

        throw error;
    }
}
