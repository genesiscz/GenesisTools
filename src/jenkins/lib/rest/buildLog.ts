import { parseJenkinsInput } from "../mcp/url";

export interface BuildLogRequest {
    target: string;
    build?: string;
    node?: string;
    tail?: number;
    head?: number;
    grep?: string;
}

/**
 * A build URL keeps its own number, a job path ending in `/<number>` is split into path and
 * build, and anything else means the last build.
 */
export function resolveTarget(target: string, build?: string): { target: string; build?: string } {
    if (build) {
        return { target, build };
    }

    if (target.startsWith("http")) {
        return parseJenkinsInput(target).buildNumber ? { target } : { target, build: "lastBuild" };
    }

    const match = target.match(/^(.+?)\/(\d+)\/?$/);

    if (match?.[1] && match[2]) {
        return { target: match[1], build: match[2] };
    }

    return { target, build: "lastBuild" };
}

/** The `jenkins mcp log` arguments for a request: the log fetcher, its cache and its printing live there. */
export function mcpLogArgs({ target, build, node, tail, head, grep }: BuildLogRequest): string[] {
    const resolved = resolveTarget(target, build);
    const args = ["log", resolved.target];

    if (resolved.build) {
        args.push("--build", resolved.build);
    }

    if (node) {
        args.push("--node", node);
    }

    if (head !== undefined) {
        args.push("--head", String(head));
    }

    if (tail !== undefined) {
        args.push("--tail", String(tail));
    }

    if (grep) {
        args.push("--grep", grep);
    }

    return args;
}

export async function runBuildLog(request: BuildLogRequest): Promise<void> {
    const { runCli } = await import("../mcp/cli");
    await runCli(mcpLogArgs(request));
}

export function parseLineCount(value: string): number {
    const count = Number(value);

    if (!Number.isInteger(count) || count < 1) {
        throw new Error(`Expected a positive whole number, got '${value}'`);
    }

    return count;
}
