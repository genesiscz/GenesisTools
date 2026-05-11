#!/usr/bin/env node

import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import axios, { type AxiosInstance } from "axios";
import { createClient, readEnvAuth } from "./lib/client";
import { extractErrors } from "./lib/errors";
import { formatDuration, formatStageLine, statusBody } from "./lib/format";
import { fetchLog, grepLog } from "./lib/log";
import { type BuildMeta, findFailingLeaf, flattenBuildMeta, getStages } from "./lib/pipeline";
import { resolveRef } from "./lib/url";

const JOB_PATH_DESC =
    'Jenkins job path (e.g. "job/X/job/Y") or full Jenkins URL — build number and selected-node are auto-extracted from the URL.';

interface GetBuildStatusArgs {
    jobPath: string;
    buildNumber?: string;
}

interface TriggerBuildArgs {
    jobPath: string;
    parameters?: Record<string, unknown>;
}

interface GetBuildLogArgs {
    jobPath: string;
    buildNumber?: string;
    nodeId?: string;
    grep?: string;
}

interface ListJobsArgs {
    folderPath?: string;
    limit?: number;
}

interface GetBuildHistoryArgs {
    jobPath: string;
    limit?: number;
    /** When true (default), include displayName, causes, parameters, branch, SCM revision, estimatedDuration. */
    expand?: boolean;
}

interface StopBuildArgs {
    jobPath: string;
    buildNumber: string;
}

interface GetQueueArgs {
    limit?: number;
}

interface GetJobConfigArgs {
    jobPath: string;
}

interface BuildRefArgs {
    jobPath: string;
    buildNumber?: string;
}

interface GetPipelineStagesArgs extends BuildRefArgs {
    expand?: boolean;
}

class JenkinsServer {
    protected server: Server;
    protected client: AxiosInstance;
    protected baseUrl: string;

    protected getMcpServer(): Server {
        return this.server;
    }

    constructor() {
        const auth = readEnvAuth();
        this.client = createClient(auth);
        this.baseUrl = auth.url;

        this.server = new Server({ name: "jenkins-server", version: "0.2.0" }, { capabilities: { tools: {} } });

        this.setupToolHandlers();

        this.server.onerror = (error: Error) => logger.error({ err: error }, "[MCP Error]");
        process.on("SIGINT", async () => {
            logger.info("Jenkins MCP server shutting down (SIGINT)");
            await this.server.close();
            process.exit(0);
        });
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "get_build_status",
                    description: "Get the status of a Jenkins build",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: 'Build number (or "lastBuild")' },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "trigger_build",
                    description: "Trigger a new Jenkins build",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            parameters: {
                                type: "object",
                                description: "Build parameters (optional)",
                                additionalProperties: true,
                            },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "get_build_log",
                    description:
                        "Fetch a build's console log (or a single node's log when nodeId is set), strip HTML timestamp wrappers, and save to /tmp/jenkins-mcp/. Returns the file path + summary. If `grep` is set, also returns matching lines formatted as 'L<lineno>: <text>' (caps at 200 matches). Token-efficient: bytes never enter the response unless you grep.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: 'Build number (or "lastBuild")' },
                            nodeId: {
                                type: "string",
                                description: "Pipeline node id (selected-node) — fetch just this node's log",
                            },
                            grep: {
                                type: "string",
                                description: "Regex to filter lines. Returns up to 200 matches as 'L<n>: <text>' strings.",
                            },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "list_jobs",
                    description: "List Jenkins jobs in a folder or at root",
                    inputSchema: {
                        type: "object",
                        properties: {
                            folderPath: {
                                type: "string",
                                description: 'Folder path (e.g. "job/Foo"); empty for root',
                            },
                            limit: { type: "number", description: "Max jobs to return" },
                        },
                        required: [],
                    },
                },
                {
                    name: "get_build_history",
                    description:
                        "Get build history for a Jenkins job. With expand=true (default), each entry also has displayName, causes (who/what triggered), parameters, branch, SCM revision, and estimatedDuration.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            limit: { type: "number", description: "Number of recent builds (default 10)" },
                            expand: {
                                type: "boolean",
                                description:
                                    "Include richer per-build fields (default true). Pass false for a minimal status-only listing.",
                            },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "stop_build",
                    description: "Stop a running Jenkins build",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: 'Build number (or "lastBuild")' },
                        },
                        required: ["jobPath", "buildNumber"],
                    },
                },
                {
                    name: "get_queue",
                    description: "Get the current Jenkins build queue",
                    inputSchema: {
                        type: "object",
                        properties: {
                            limit: { type: "number", description: "Max queue items to return" },
                        },
                        required: [],
                    },
                },
                {
                    name: "get_job_config",
                    description: "Get the configuration of a Jenkins job",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "get_pipeline_stages",
                    description:
                        "Get the pipeline stage tree for a build (wfapi/describe). With expand=true, includes parallel branch flow nodes. Answers 'what is ?selected-node=N?'.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: "Build number" },
                            expand: {
                                type: "boolean",
                                description: "Include stageFlowNodes (parallel branches inside each stage)",
                            },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "get_failing_node",
                    description:
                        "Find the failing stage (and innermost failing flow node) for a build, fetch its log, and return regex-extracted error windows. One-shot 'what failed and why'.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: "Build number" },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "get_build_info",
                    description:
                        "Extended build info: parameters, causes (who/what triggered), builtOn (agent), executor, estimated duration.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: "Build number" },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "get_build_changes",
                    description: "SCM changeSet (commits, authors) + build trigger causes for a build.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: "Build number" },
                        },
                        required: ["jobPath"],
                    },
                },
                {
                    name: "wait_for_build",
                    description:
                        "Snapshot current build state with full stage list + durations, then suggest the CLI 'monitor' command to background via Bash for live JSONL events and click-to-Brave notifications. Does NOT poll itself.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            jobPath: { type: "string", description: JOB_PATH_DESC },
                            buildNumber: { type: "string", description: "Build number" },
                        },
                        required: ["jobPath"],
                    },
                },
            ],
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                const args = request.params.arguments ?? {};
                switch (request.params.name) {
                    case "get_build_status":
                        return await this.getBuildStatus(args as unknown as GetBuildStatusArgs);
                    case "trigger_build":
                        return await this.triggerBuild(args as unknown as TriggerBuildArgs);
                    case "get_build_log":
                        return await this.getBuildLog(args as unknown as GetBuildLogArgs);
                    case "list_jobs":
                        return await this.listJobs(args as unknown as ListJobsArgs);
                    case "get_build_history":
                        return await this.getBuildHistory(args as unknown as GetBuildHistoryArgs);
                    case "stop_build":
                        return await this.stopBuild(args as unknown as StopBuildArgs);
                    case "get_queue":
                        return await this.getQueue(args as unknown as GetQueueArgs);
                    case "get_job_config":
                        return await this.getJobConfig(args as unknown as GetJobConfigArgs);
                    case "get_pipeline_stages":
                        return await this.getPipelineStages(args as unknown as GetPipelineStagesArgs);
                    case "get_failing_node":
                        return await this.getFailingNode(args as unknown as BuildRefArgs);
                    case "get_build_info":
                        return await this.getBuildInfo(args as unknown as BuildRefArgs);
                    case "get_build_changes":
                        return await this.getBuildChanges(args as unknown as BuildRefArgs);
                    case "wait_for_build":
                        return await this.waitForBuild(args as unknown as BuildRefArgs);
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
                }
            } catch (error) {
                if (error instanceof McpError) {
                    throw error;
                }

                if (axios.isAxiosError(error)) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Jenkins API error: ${error.response?.data?.message || error.message}`
                    );
                }

                throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : "Unknown error");
            }
        });
    }

    private text(value: unknown) {
        return {
            content: [
                {
                    type: "text",
                    text: typeof value === "string" ? value : SafeJSON.stringify(value, null, 2),
                },
            ],
        };
    }

    private async getBuildStatus(args: GetBuildStatusArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber });
        const build = ref.buildNumber ?? "lastBuild";
        const res = await this.client.get(`/${ref.jobPath}/${build}/api/json`);

        if (res.status !== 200) {
            throw new Error(`Build status returned ${res.status}`);
        }

        return this.text({
            building: res.data.building,
            result: res.data.result,
            timestamp: res.data.timestamp,
            duration: res.data.duration,
            url: res.data.url,
        });
    }

    private async triggerBuild(args: TriggerBuildArgs) {
        const ref = resolveRef({ input: args.jobPath });
        const params = new URLSearchParams();

        if (args.parameters) {
            for (const [key, value] of Object.entries(args.parameters)) {
                params.append(key, String(value));
            }
        }

        const endpoint = args.parameters ? `/${ref.jobPath}/buildWithParameters` : `/${ref.jobPath}/build`;
        await this.client.post(endpoint, params);
        return this.text("Build triggered successfully");
    }

    private async getBuildLog(args: GetBuildLogArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber, nodeOverride: args.nodeId });
        const build = ref.buildNumber ?? "lastBuild";
        const result = await fetchLog(this.client, ref.jobPath, build, { nodeId: ref.nodeId });

        const base = {
            path: result.path,
            sizeBytes: result.sizeBytes,
            lineCount: result.lineCount,
            nodeStatus: result.nodeStatus,
            truncated: result.truncated,
        };

        if (args.grep) {
            return this.text({ ...base, matches: grepLog(result.content, args.grep) });
        }

        return this.text(base);
    }

    private async listJobs(args: ListJobsArgs) {
        const folderPath = args.folderPath?.replace(/^\/+/, "").replace(/\/+$/, "") ?? "";
        const apiPath = folderPath ? `/${folderPath}/api/json` : "/api/json";
        const res = await this.client.get(apiPath);
        const all = (res.data.jobs ?? []) as Array<{
            name: string;
            url: string;
            color: string;
            buildable: boolean;
            lastBuild?: { number: number; url: string };
        }>;
        const limited = args.limit !== undefined ? all.slice(0, args.limit) : all;
        const jobs = limited.map((job) => ({
            name: job.name,
            url: job.url,
            color: job.color,
            buildable: job.buildable,
            lastBuildNumber: job.lastBuild?.number,
            lastBuildUrl: job.lastBuild?.url,
        }));
        return this.text({
            folderPath: folderPath || "root",
            totalJobs: all.length,
            returned: jobs.length,
            jobs,
        });
    }

    private async getBuildHistory(args: GetBuildHistoryArgs) {
        const ref = resolveRef({ input: args.jobPath });
        const limit = args.limit ?? 10;
        const expand = args.expand ?? true;
        const baseFields = "number,result,timestamp,duration,building,url";
        const expandedFields = expand
            ? `,displayName,estimatedDuration,actions[causes[shortDescription,upstreamProject,upstreamBuild],parameters[name,value],lastBuiltRevision[branch[name,SHA1]],remoteUrls]`
            : "";
        const treeQuery = `builds[${baseFields}${expandedFields}]{0,${limit}}`;
        const res = await this.client.get(`/${ref.jobPath}/api/json?tree=${treeQuery}`);
        const builds = (res.data.builds ?? []) as Array<{
            number: number;
            result: string | null;
            timestamp: number;
            duration: number;
            building: boolean;
            url: string;
            displayName?: string;
            estimatedDuration?: number;
            actions?: unknown[];
        }>;
        const buildHistory = builds.map((b) => {
            const base = {
                number: b.number,
                result: b.result,
                timestamp: b.timestamp,
                duration: b.duration,
                building: b.building,
                url: b.url,
                date: new Date(b.timestamp).toISOString(),
            };

            if (!expand) {
                return base;
            }

            const meta = flattenBuildMeta(b.actions);
            return {
                ...base,
                displayName: b.displayName,
                estimatedDuration: b.estimatedDuration,
                ...meta,
            };
        });
        return this.text({ jobPath: ref.jobPath, totalBuilds: buildHistory.length, builds: buildHistory });
    }

    private async stopBuild(args: StopBuildArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber });

        if (!ref.buildNumber) {
            throw new Error("buildNumber required");
        }

        await this.client.post(`/${ref.jobPath}/${ref.buildNumber}/stop`);
        return this.text(`Build ${ref.buildNumber} stopped successfully`);
    }

    private async getQueue(args: GetQueueArgs) {
        const res = await this.client.get("/queue/api/json");
        const all = (res.data.items ?? []) as Array<{
            id: number;
            task: { name: string; url: string };
            why: string;
            inQueueSince: number;
            stuck: boolean;
        }>;
        const limited = args.limit !== undefined ? all.slice(0, args.limit) : all;
        const queue = limited.map((item) => ({
            id: item.id,
            taskName: item.task.name,
            taskUrl: item.task.url,
            reason: item.why,
            inQueueSince: item.inQueueSince,
            inQueueSinceDate: new Date(item.inQueueSince).toISOString(),
            stuck: item.stuck,
        }));
        return this.text({ totalQueueItems: all.length, returned: queue.length, queue });
    }

    private async getJobConfig(args: GetJobConfigArgs) {
        const ref = resolveRef({ input: args.jobPath });
        const res = await this.client.get(`/${ref.jobPath}/api/json`);
        const info = res.data;
        return this.text({
            name: info.name,
            url: info.url,
            description: info.description,
            buildable: info.buildable,
            color: info.color,
            inQueue: info.inQueue,
            keepDependencies: info.keepDependencies,
            nextBuildNumber: info.nextBuildNumber,
            property: info.property,
            scm: info.scm,
            triggers: info.triggers,
            upstreamProjects: info.upstreamProjects,
            downstreamProjects: info.downstreamProjects,
            lastBuild: info.lastBuild,
            lastCompletedBuild: info.lastCompletedBuild,
            lastFailedBuild: info.lastFailedBuild,
            lastStableBuild: info.lastStableBuild,
            lastSuccessfulBuild: info.lastSuccessfulBuild,
            lastUnstableBuild: info.lastUnstableBuild,
            lastUnsuccessfulBuild: info.lastUnsuccessfulBuild,
        });
    }

    private async getPipelineStages(args: GetPipelineStagesArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber });

        if (!ref.buildNumber) {
            throw new Error("buildNumber required (pass as arg or include in URL)");
        }

        const snap = await getStages(this.client, ref.jobPath, ref.buildNumber, { expand: args.expand });
        return this.text(snap);
    }

    private async getFailingNode(args: BuildRefArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber });

        if (!ref.buildNumber) {
            throw new Error("buildNumber required");
        }

        const snap = await getStages(this.client, ref.jobPath, ref.buildNumber, { expand: true });
        const failing = findFailingLeaf(snap);

        if (!failing) {
            return this.text({
                stage: null,
                message:
                    snap.status === "SUCCESS"
                        ? "Build succeeded — no failing node"
                        : `Build status: ${snap.status} — no FAILED stage found`,
            });
        }

        const nodeId = failing.node?.id ?? failing.stage.id;
        const log = await fetchLog(this.client, ref.jobPath, ref.buildNumber, { nodeId });
        const errors = extractErrors(log.content);

        return this.text({
            stage: { id: failing.stage.id, name: failing.stage.name, status: failing.stage.status },
            failingNode: failing.node
                ? { id: failing.node.id, name: failing.node.name, status: failing.node.status }
                : null,
            logPath: log.path,
            sizeBytes: log.sizeBytes,
            lineCount: log.lineCount,
            errors,
        });
    }

    private async getBuildInfo(args: BuildRefArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber });
        const build = ref.buildNumber ?? "lastBuild";
        const tree =
            "number,result,building,duration,timestamp,builtOn,displayName,estimatedDuration,executor[*],actions[parameters[name,value],causes[shortDescription,userId,upstreamProject,upstreamBuild],lastBuiltRevision[branch[name,SHA1]],remoteUrls]";
        const res = await this.client.get(`/${ref.jobPath}/${build}/api/json?tree=${tree}`);
        const data = res.data as {
            number: number;
            result: string | null;
            building: boolean;
            duration: number;
            timestamp: number;
            builtOn?: string;
            displayName?: string;
            estimatedDuration?: number;
            executor?: unknown;
            actions?: unknown[];
        };
        const meta: BuildMeta = flattenBuildMeta(data.actions);
        return this.text({
            number: data.number,
            result: data.result,
            building: data.building,
            duration: data.duration,
            timestamp: data.timestamp,
            date: new Date(data.timestamp).toISOString(),
            builtOn: data.builtOn,
            displayName: data.displayName,
            estimatedDuration: data.estimatedDuration,
            executor: data.executor,
            ...meta,
        });
    }

    private async getBuildChanges(args: BuildRefArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber });
        const build = ref.buildNumber ?? "lastBuild";
        const tree =
            "changeSet[items[commitId,author[fullName],msg,timestamp,affectedPaths]],actions[causes[shortDescription,userId,upstreamProject,upstreamBuild]]";
        const res = await this.client.get(`/${ref.jobPath}/${build}/api/json?tree=${tree}`);
        const changeCount = res.data.changeSet?.items?.length ?? 0;
        const causes =
            (res.data.actions ?? []).flatMap((a: { causes?: unknown[] }) => a.causes ?? []).filter(Boolean) ?? [];
        return this.text({
            jobPath: ref.jobPath,
            buildNumber: build,
            changeCount,
            changes: res.data.changeSet?.items ?? [],
            causes,
        });
    }

    private async waitForBuild(args: BuildRefArgs) {
        const ref = resolveRef({ input: args.jobPath, buildOverride: args.buildNumber });

        if (!ref.buildNumber) {
            return this.text(
                "Need a buildNumber — pass it as an argument or use a URL containing /<build>/ in jobPath."
            );
        }

        const snap = await getStages(this.client, ref.jobPath, ref.buildNumber, { expand: true });
        const now = Date.now();
        const lines = ["Stages:"];

        for (const stage of snap.stages) {
            lines.push(`  ${formatStageLine(stage, now)}`);

            for (const branch of stage.stageFlowNodes ?? []) {
                lines.push(`    ├ ${formatStageLine(branch, now)}`);
            }
        }

        const cmd = `tools jenkins-mcp monitor "${ref.jobPath}" --build ${ref.buildNumber} --timeout 30m`;
        const isDone = snap.status !== "IN_PROGRESS";
        const elapsed = snap.startTimeMillis ? formatDuration(now - snap.startTimeMillis) : "?";
        const status = isDone
            ? `Build ${ref.buildNumber} already finished — ${statusBody(snap.status)} (${formatDuration(snap.durationMillis)}).`
            : `Build ${ref.buildNumber} is IN_PROGRESS (running ${elapsed}).`;

        return this.text({
            status,
            stageSummary: lines,
            suggestCommand: isDone ? undefined : cmd,
            recommendation: isDone
                ? undefined
                : "Run this via Bash with run_in_background: true. The harness will notify you when the monitor exits. Click any stage notification to open the build in your default browser.",
        });
    }
}

class JenkinsServerWithRun extends JenkinsServer {
    async run(): Promise<void> {
        const transport = new StdioServerTransport();
        await this.getMcpServer().connect(transport);
        logger.info("Jenkins MCP server running on stdio");
    }
}

export async function runMcp(): Promise<void> {
    const server = new JenkinsServerWithRun();
    await server.run();
}
