import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { parseJenkinsInput } from "../mcp/url";
import {
    findJobDefinition,
    getDownstreamJobs,
    getJobNameFromPath,
    getJobType,
    isMasterBuild,
    type JobContext,
} from "./jobs";
import type { AnalysisResult, JenkinsBuild, SuggestedAction } from "./types";

export interface ParsedBuildUrl {
    jobPath: string;
    buildNumber?: number;
    isConsole: boolean;
    isPipelineOverview: boolean;
}

/** A full build URL or a `job/...` path; null when it names no job. */
export function parseBuildUrl(input: string): ParsedBuildUrl | null {
    let ref: ReturnType<typeof parseJenkinsInput>;

    try {
        ref = parseJenkinsInput(input);
    } catch {
        return null;
    }

    if (!/(^|\/)job\/[^/]+/.test(ref.jobPath)) {
        return null;
    }

    return {
        jobPath: ref.jobPath,
        buildNumber: ref.buildNumber ? Number.parseInt(ref.buildNumber, 10) : undefined,
        isConsole: ref.page?.startsWith("console") ?? false,
        isPipelineOverview: ref.page === "pipeline-overview",
    };
}

export function isJenkinsTarget(input: string): boolean {
    return input.startsWith("http://") || input.startsWith("https://") || input.startsWith("job/");
}

function downstreamNames(jobPath: string, ctx: JobContext): string {
    return getDownstreamJobs(jobPath, ctx).map(getJobNameFromPath).join(" + ") || "downstream builds";
}

export function generateSuggestedActions(
    jobPath: string,
    buildNumber: number | undefined,
    build: JenkinsBuild | null,
    isConsole = false,
    ctx: JobContext = {}
): SuggestedAction[] {
    const actions: SuggestedAction[] = [];
    const jobName = getJobNameFromPath(jobPath);
    const buildArg = String(buildNumber ?? "latest");
    const master = isMasterBuild(jobPath, ctx);

    if (build?.building) {
        actions.push({
            id: "monitor",
            command: toolCommand("jenkins monitor", jobPath, buildArg),
            description: "Monitor build until completion",
            priority: 1,
            reason: "Build is currently in progress",
        });
    }

    if (master) {
        actions.push({
            id: "track-pipeline",
            command: toolCommand("jenkins track", jobPath, buildArg),
            description: `Track full pipeline (${jobName} triggers ${downstreamNames(jobPath, ctx)})`,
            priority: build?.building ? 2 : 1,
            reason: "This is a master build that triggers downstream builds",
        });
    }

    if (build?.result === "FAILURE") {
        actions.push(
            {
                id: "rebuild",
                command: toolCommand("jenkins rebuild", jobPath, buildArg),
                description: "Rebuild with the same parameters",
                priority: 1,
                reason: "Build failed, rerun with identical params",
            },
            {
                id: "search-logs",
                command: toolCommand("jenkins search-logs", jobPath, buildArg),
                description: "Search logs for error patterns",
                priority: 2,
                reason: "Build failed, investigate errors",
            },
            {
                id: "view-logs",
                command: toolCommand("jenkins logs", jobPath, buildArg),
                description: "View full build log",
                priority: 3,
                reason: "Build failed, review complete log",
            }
        );
    }

    if (build?.result === "SUCCESS" && master) {
        actions.push({
            id: "verify-downstream",
            command: toolCommand("jenkins track", jobPath, buildArg),
            description: "Verify downstream builds succeeded",
            priority: 1,
            reason: "Master build succeeded, verify downstream builds",
        });
    }

    if (build && !build.building && build.result !== "FAILURE") {
        actions.push({
            id: "view-logs",
            command: toolCommand("jenkins logs", jobPath, buildArg),
            description: "View build log",
            priority: 3,
            reason: "Build completed, review log if needed",
        });
    }

    if (isConsole && buildNumber) {
        actions.push({
            id: "search-warnings",
            command: `${toolCommand("jenkins search-logs", jobPath, buildArg)} --pattern "WARNING|WARN"`,
            description: "Search logs for warnings",
            priority: 2,
            reason: "Console view, search for warnings",
        });
    }

    if (!buildNumber) {
        actions.push({
            id: "monitor-latest",
            command: toolCommand("jenkins monitor", jobPath, "latest"),
            description: "Monitor latest build",
            priority: 1,
            reason: "No build number specified, monitor latest",
        });
    }

    return actions.sort((a, b) => a.priority - b.priority);
}

export function formatAnalysisOutput(analysis: AnalysisResult): string {
    const lines = [
        "# Jenkins Build Analysis",
        `# Job: ${analysis.jobName}${analysis.buildNumber ? ` #${analysis.buildNumber}` : ""}`,
    ];

    if (analysis.isBuilding !== undefined) {
        lines.push(`# Status: ${analysis.isBuilding ? "BUILDING" : (analysis.buildStatus ?? "UNKNOWN")}`);
    }

    if (analysis.timestamp) {
        lines.push(`# Started: ${new Date(analysis.timestamp).toLocaleString()}`);
    }

    lines.push("", "# Suggested Actions (in priority order):", "");

    for (const action of analysis.suggestedActions) {
        lines.push(`## [${action.priority}] ${action.description}`, action.command, `# Reason: ${action.reason}`, "");
    }

    if (analysis.context) {
        lines.push("# Additional Context:", `# ${analysis.context}`);
    }

    return lines.join("\n");
}

/** Context and next commands for a build URL; `build` adds the live status when it could be fetched. */
export function analyzeUrl(
    input: string,
    build: JenkinsBuild | null = null,
    ctx: JobContext = {}
): AnalysisResult | null {
    const parsed = parseBuildUrl(input);

    if (!parsed) {
        return null;
    }

    const { jobPath, buildNumber, isConsole, isPipelineOverview } = parsed;
    const context: string[] = [];

    if (isMasterBuild(jobPath, ctx)) {
        context.push(`This is a master build that triggers ${downstreamNames(jobPath, ctx)}`);
    }

    if (isPipelineOverview) {
        context.push("Pipeline overview view - shows downstream build stages");
    }

    if (isConsole) {
        context.push("Console view - showing build output");
    }

    const definition = findJobDefinition(jobPath, ctx);

    if (definition?.byTag) {
        context.push("This is a tag-based build (requires TAG parameter)");
    }

    if (definition?.automatic) {
        context.push("This build is automatically triggered by commits/merges");
    }

    return {
        jobPath,
        buildNumber,
        jobName: getJobNameFromPath(jobPath),
        jobType: getJobType(jobPath, ctx),
        buildStatus: build?.result,
        isBuilding: build?.building,
        suggestedActions: generateSuggestedActions(jobPath, buildNumber, build, isConsole, ctx),
        context: context.join(". "),
        timestamp: build?.timestamp,
        estimatedDuration: build?.estimatedDuration,
    };
}
