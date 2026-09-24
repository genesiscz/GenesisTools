import { type GitLabApi, graphql } from "@app/gitlab/lib/client";
import { errorMessage, isRetryableError } from "@app/gitlab/lib/http";
import { SafeJSON } from "@genesiscz/utils/json";

export interface MRNode {
    iid: string;
    title: string;
    sourceBranch: string;
    targetBranch: string;
    webUrl: string;
    updatedAt: string;
    commitCount: number | null;
    divergedFromTargetBranch: boolean;
    diffStats: Array<{ path: string }> | null;
}

interface QueryResult {
    project: {
        mergeRequests: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            nodes: MRNode[];
        };
    } | null;
}

const QUERY = `
query($projectPath: ID!, $after: String) {
  project(fullPath: $projectPath) {
    mergeRequests(state: opened, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid
        title
        sourceBranch
        targetBranch
        webUrl
        updatedAt
        commitCount
        divergedFromTargetBranch
        diffStats { path }
      }
    }
  }
}`;

const MAX_RETRIES = 5;

async function fetchPage(
    api: GitLabApi,
    page: { projectPath: string; after: string | null; log: (msg: string) => void }
): Promise<QueryResult> {
    const variables: Record<string, unknown> = { projectPath: page.projectPath };
    if (page.after) {
        variables.after = page.after;
    }

    for (let attempt = 1; ; attempt++) {
        try {
            return await graphql<QueryResult>(api, QUERY, variables);
        } catch (e) {
            // A 401, a 403 or a GraphQL validation error is permanent: retrying only made the
            // command wait 20 s before failing with the same message.
            if (attempt >= MAX_RETRIES || !isRetryableError(e)) {
                throw e;
            }

            page.log(`  [retry ${attempt}/${MAX_RETRIES}] ${errorMessage(e)}`);
            await Bun.sleep(2000 * attempt);
        }
    }
}

function matchesPath(path: string, files: string[]): boolean {
    return files.some((f) => path === f || path.endsWith(`/${f}`));
}

export function matchedPaths(mr: MRNode, files: string[]): string[] {
    return (mr.diffStats ?? []).filter((ds) => matchesPath(ds.path, files)).map((ds) => ds.path);
}

export interface SearchResult {
    matches: MRNode[];
    scanned: number;
}

/** Open MRs of `projectPath` (a full path, GraphQL takes no numeric id) whose diff touches any of `files`. */
export async function searchMrsByFiles(
    api: GitLabApi,
    search: { projectPath: string; files: string[]; log: (msg: string) => void }
): Promise<SearchResult> {
    const { projectPath, files, log } = search;
    log(`Searching open MRs of ${projectPath} for files: ${files.join(", ")}`);

    const allMRs: MRNode[] = [];
    let after: string | null = null;

    for (let pageNum = 1; ; pageNum++) {
        log(`  page ${pageNum}: fetching...`);
        const data = await fetchPage(api, { projectPath, after, log });

        if (!data.project) {
            throw new Error(`Project ${projectPath} not found, or the token cannot read it.`);
        }

        const page = data.project.mergeRequests;
        allMRs.push(...page.nodes);
        log(`  page ${pageNum}: got ${page.nodes.length} MRs (total: ${allMRs.length})`);

        if (!page.pageInfo.hasNextPage) {
            break;
        }

        after = page.pageInfo.endCursor;
    }

    log(`Scanned ${allMRs.length} open MRs`);

    const matches = allMRs.filter((mr) => matchedPaths(mr, files).length > 0);
    matches.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    log(`Found ${matches.length} MRs touching ${files.join(" or ")}`);

    return { matches, scanned: allMRs.length };
}

export function formatSearchJson(matches: MRNode[], files: string[]): string {
    const rows = matches.map((mr) => ({
        iid: mr.iid,
        title: mr.title,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        url: mr.webUrl,
        updatedAt: mr.updatedAt,
        commits: mr.commitCount ?? 0,
        diverged: mr.divergedFromTargetBranch,
        matchedFiles: matchedPaths(mr, files),
    }));

    return SafeJSON.stringify(rows, null, 2);
}

export function formatSearchText(matches: MRNode[], files: string[]): string {
    if (!matches.length) {
        return `No open MRs touch ${files.join(" or ")}.`;
    }

    const lines: string[] = [];
    lines.push(`${matches.length} MRs touch ${files.join(" or ")} (oldest first):\n`);

    for (const mr of matches) {
        const commits = mr.commitCount ?? 0;
        const diverged = mr.divergedFromTargetBranch ? "⚠️ diverged" : "✅ up-to-date";
        const date = mr.updatedAt.slice(0, 10);
        lines.push(`  !${mr.iid}  ${mr.title.slice(0, 55)}  [${date}] [${commits} commits] [${diverged}]`);
        lines.push(`         ${mr.sourceBranch} → ${mr.targetBranch}`);
        lines.push(`         files: ${matchedPaths(mr, files).join(", ")}`);
        lines.push("");
    }

    lines.push("IIDs for batch comment:");
    lines.push(matches.map((mr) => mr.iid).join(","));

    return lines.join("\n");
}
