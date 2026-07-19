import { basename } from "node:path";
import {
    getSessionListing,
    rgExtractSnippet,
    rgSearchFiles,
    type SessionMetadataRecord,
    searchConversations,
} from "@app/claude/lib/history/search";
import * as p from "@clack/prompts";
import { findClaudeCommand, resolveProjectFilter } from "@genesiscz/utils/claude";
import { getSessionMetadata } from "@genesiscz/utils/claude/history-cache";
import { buildSessionTableOpts } from "@genesiscz/utils/claude/session-display";
import { isInteractive } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { tableSelect } from "@genesiscz/utils/prompts/clack/table-select";
import type { Command } from "commander";
import pc from "picocolors";

// --- Constants ---

const PROMPT_PREVIEW_LEN = 60;

// --- Types ---

export interface DisplaySession {
    sessionId: string;
    name: string;
    summary: string;
    branch: string;
    project: string;
    modified: string;
    source: "cache" | "search";
    firstPrompt: string;
    matchSnippet?: string;
}

interface ResumeOptions {
    list?: boolean;
    allProjects?: boolean;
    limit: string;
}

// --- Helpers ---

function toDisplay(
    sessionId: string,
    opts: {
        title?: string | null;
        summary?: string | null;
        firstPrompt?: string | null;
        branch?: string | null;
        project?: string | null;
        timestamp?: string | null;
        source?: "cache" | "search";
        matchSnippet?: string;
    }
): DisplaySession {
    return {
        sessionId,
        name: opts.title || opts.summary || opts.firstPrompt?.slice(0, PROMPT_PREVIEW_LEN) || "(unnamed)",
        summary: opts.summary || "",
        branch: opts.branch || "",
        project: opts.project || "",
        modified: opts.timestamp || "",
        source: opts.source ?? "cache",
        firstPrompt: opts.firstPrompt || "",
        matchSnippet: opts.matchSnippet,
    };
}

function dedup(sessions: DisplaySession[]): DisplaySession[] {
    const seen = new Set<string>();
    return sessions.filter((s) => {
        if (seen.has(s.sessionId)) {
            return false;
        }
        seen.add(s.sessionId);
        return true;
    });
}

// --- Data ---

type Spinner = ReturnType<typeof p.spinner>;

function progressUpdater(spinner: Spinner) {
    return (processed: number, total: number, file: string) => {
        const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
        const shortId = file.length > 8 ? file.slice(0, 8) : file;
        spinner.message(`${processed}/${total} (${pct}%) ${shortId}...`);
    };
}

interface LoadResult {
    sessions: DisplaySession[];
    total: number;
    subagents: number;
    project: string | undefined;
    indexed: number;
    staleRemoved: number;
    reindexed: boolean;
    projectCount: number;
    scope: string;
}

async function loadSessions(allProjects: boolean, spinner: Spinner): Promise<LoadResult> {
    const project = allProjects ? undefined : resolveProjectFilter();
    const result = await getSessionListing({
        project,
        excludeSubagents: true,
        onProgress: progressUpdater(spinner),
    });
    return {
        sessions: result.sessions.map((s: SessionMetadataRecord) =>
            toDisplay(s.sessionId || basename(s.filePath, ".jsonl"), {
                title: s.customTitle,
                summary: s.summary,
                firstPrompt: s.firstPrompt,
                branch: s.gitBranch,
                project: s.project,
                timestamp: new Date(s.mtime).toISOString(),
            })
        ),
        total: result.total,
        subagents: result.subagents,
        project,
        indexed: result.indexed,
        staleRemoved: result.staleRemoved,
        reindexed: result.reindexed,
        projectCount: result.projectCount,
        scope: result.scope,
    };
}

function normalizeAlphanumeric(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scoreContentMatch(s: DisplaySession, query: string): number {
    const q = query.toLowerCase();
    const qNorm = normalizeAlphanumeric(q);
    let score = 0;

    if (s.name.toLowerCase().includes(q)) {
        score += 100;
    } else if (qNorm.length >= 3 && normalizeAlphanumeric(s.name).includes(qNorm)) {
        score += 80;
    }

    if (s.firstPrompt.toLowerCase().includes(q)) {
        score += 50;
    } else if (qNorm.length >= 3 && normalizeAlphanumeric(s.firstPrompt).includes(qNorm)) {
        score += 40;
    }

    if (s.branch.toLowerCase().includes(q)) {
        score += 30;
    }

    if (s.project.toLowerCase().includes(q)) {
        score += 20;
    } else if (qNorm.length >= 3 && normalizeAlphanumeric(s.project).includes(qNorm)) {
        score += 15;
    }

    if (s.modified) {
        const ageDays = (Date.now() - new Date(s.modified).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays < 7) {
            score += Math.round(20 * (1 - ageDays / 7));
        }
    }

    return score;
}

function matchByIdOrName(all: DisplaySession[], query: string): DisplaySession[] {
    const q = query.toLowerCase();
    const byId = all.filter((s) => s.sessionId.toLowerCase().startsWith(q));
    if (byId.length > 0) {
        return byId;
    }

    const exact = all.filter(
        (s) =>
            s.name.toLowerCase().includes(q) ||
            s.branch.toLowerCase().includes(q) ||
            s.project.toLowerCase().includes(q) ||
            s.firstPrompt.toLowerCase().includes(q)
    );
    if (exact.length > 0) {
        return exact;
    }

    // Normalized match: strip non-alphanumeric, retry substring.
    // Catches "last24h" matching "last 24 hours", "devdashboard" matching "dev-dashboard", etc.
    const qNorm = normalizeAlphanumeric(q);
    if (qNorm.length >= 3) {
        return all.filter((s) =>
            [s.name, s.branch, s.project, s.firstPrompt].some((f) => normalizeAlphanumeric(f).includes(qNorm))
        );
    }

    return [];
}

interface ContentSearchResult {
    sessions: DisplaySession[];
    metaHits: number;
    rgTotalHits: number;
    rgUniqueHits: number;
    overlap: number;
}

async function searchByContent(query: string, spinner: Spinner, project?: string): Promise<ContentSearchResult> {
    const [metaResults, matchingFiles] = await Promise.all([
        searchConversations({
            query,
            project,
            sortByRelevance: true,
            limit: 20,
            summaryOnly: true,
        }),
        rgSearchFiles(query, { project, limit: 30 }),
    ]);

    const metaSessions = metaResults.map((r) =>
        toDisplay(r.sessionId, {
            title: r.customTitle,
            summary: r.summary,
            branch: r.gitBranch,
            project: r.project,
            timestamp: r.timestamp.toISOString(),
            source: "search",
        })
    );

    const metaSessionIds = new Set(metaSessions.map((s) => s.sessionId));

    const rgOnlyFiles = matchingFiles.filter((filePath) => {
        const cached = getSessionMetadata(filePath);
        const sid = cached?.sessionId || basename(filePath, ".jsonl");
        return !metaSessionIds.has(sid);
    });

    if (rgOnlyFiles.length > 0) {
        spinner.message(`Loading ${rgOnlyFiles.length} deep matches...`);
    }

    const rgSessions: DisplaySession[] = [];
    const remainingSlots = Math.max(5, 20 - metaSessions.length);
    for (const filePath of rgOnlyFiles.slice(0, remainingSlots)) {
        const cached = getSessionMetadata(filePath);
        const snippet = await rgExtractSnippet(query, filePath);

        rgSessions.push(
            toDisplay(cached?.sessionId || basename(filePath, ".jsonl"), {
                title: cached?.customTitle,
                summary: cached?.summary,
                firstPrompt: cached?.firstPrompt,
                branch: cached?.gitBranch,
                project: cached?.project,
                timestamp: cached?.firstTimestamp || new Date(0).toISOString(),
                source: "search",
                matchSnippet: snippet,
            })
        );
    }

    const overlap = matchingFiles.length - rgOnlyFiles.length;

    return {
        sessions: [...metaSessions, ...rgSessions],
        metaHits: metaSessions.length,
        rgTotalHits: matchingFiles.length,
        rgUniqueHits: rgOnlyFiles.length,
        overlap,
    };
}

// --- UI ---

async function selectSession(candidates: DisplaySession[], query?: string): Promise<DisplaySession> {
    if (candidates.length === 1) {
        const s = candidates[0];
        p.log.info(
            `${pc.bold(s.name)} ${pc.dim(s.sessionId.slice(0, 8))} ${pc.magenta(s.branch)} ${s.project ? pc.blue(s.project) : ""}`
        );
        return s;
    }

    if (!isInteractive()) {
        const s = candidates[0];
        p.log.info(`Auto-selected: ${pc.bold(s.name)} ${pc.dim(s.sessionId.slice(0, 8))}`);
        return s;
    }

    const opts = buildSessionTableOpts(candidates, {
        message: "Select session to resume:",
        query,
    });

    const result = await tableSelect(opts);

    if (!result) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return result;
}

async function resumeSession(session: DisplaySession): Promise<never> {
    if (!/^[\w-]+$/.test(session.sessionId)) {
        throw new Error(`Invalid session ID: ${session.sessionId}`);
    }

    const cmd = await findClaudeCommand();
    p.outro(`${pc.green("Resuming:")} ${cmd} --resume ${session.sessionId}`);

    const shell = env.paths.getShell("/bin/sh");
    const proc = Bun.spawn({
        cmd: [shell, "-ic", `exec ${cmd} --resume '${session.sessionId}'`],
        stdio: ["inherit", "inherit", "inherit"],
    });

    const exitCode = await proc.exited;
    process.exit(exitCode);
}

// --- Main logic ---

export interface SessionPickOptions {
    list?: boolean;
    allProjects?: boolean;
    limit?: number;
}

/**
 * Interactive session selection (load → match → content-search → select).
 * Shared by `tools claude resume` and `tools claude start --resume <query>`.
 */
export async function pickSessionForResume(
    query: string | undefined,
    opts: SessionPickOptions = {}
): Promise<DisplaySession> {
    const limit = opts.limit ?? 20;

    const spinner = p.spinner();
    spinner.start("Loading sessions...");
    const loadResult = await loadSessions(opts.allProjects ?? false, spinner);
    const { sessions, subagents, project, indexed, staleRemoved, reindexed, projectCount, scope } = loadResult;

    const statsParts = [
        `${sessions.length} sessions`,
        subagents > 0 ? `${subagents} subagents` : "",
        `${projectCount} projects`,
        pc.dim(`[${scope}]`),
    ].filter(Boolean);

    const indexParts = [
        reindexed ? pc.yellow("reindexed") : "",
        indexed > 0 ? `${indexed} new` : "",
        staleRemoved > 0 ? `${staleRemoved} stale removed` : "",
    ].filter(Boolean);

    const statsLine =
        indexParts.length > 0
            ? `${statsParts.join(", ")} ${pc.dim("(")}${indexParts.join(", ")}${pc.dim(")")}`
            : statsParts.join(", ");
    spinner.stop(statsLine);

    if (sessions.length === 0) {
        p.log.error("No sessions found");
        process.exit(1);
    }

    let candidates: DisplaySession[];

    if (!query || opts.list) {
        candidates = sessions.slice(0, limit);
    } else {
        candidates = matchByIdOrName(sessions, query);

        if (candidates.length > 0) {
            candidates.sort((a, b) => scoreContentMatch(b, query) - scoreContentMatch(a, query));
            p.log.info(
                pc.dim(`index: ${candidates.length} match${candidates.length !== 1 ? "es" : ""} `) +
                    pc.dim(`(name/branch/project/prompt)`)
            );
        } else {
            p.log.info(pc.dim(`index: 0 matches for "${query}", searching content...`));
            const searchSpinner = p.spinner();
            searchSpinner.start("Searching...");
            const result = await searchByContent(query, searchSpinner, project);

            const searchStatsParts = [
                `${pc.cyan(`${result.metaHits}`)} meta`,
                `${pc.cyan(`${result.rgTotalHits}`)} rg`,
                result.overlap > 0 ? `${result.overlap} overlap` : "",
                result.rgUniqueHits > 0 ? `${pc.yellow(`${result.rgUniqueHits}`)} rg-only` : "",
            ].filter(Boolean);
            searchSpinner.stop(`${result.sessions.length} matches ${pc.dim(`(${searchStatsParts.join(", ")})`)}`);

            if (result.sessions.length > 0) {
                candidates = dedup(
                    result.sessions.map((h) => {
                        const cached = sessions.find((s) => s.sessionId === h.sessionId);
                        return cached ? { ...cached, source: "search" as const, matchSnippet: h.matchSnippet } : h;
                    })
                );
                // Rank by metadata relevance so sessions whose name/prompt matches
                // sort above sessions where the query only appears in tool output
                candidates.sort((a, b) => scoreContentMatch(b, query) - scoreContentMatch(a, query));
            }
        }

        if (candidates.length === 0) {
            p.log.warn("No matches. Showing recent:");
            candidates = sessions.slice(0, limit);
        }
    }

    return selectSession(candidates, query);
}

async function main(query: string | undefined, opts: ResumeOptions) {
    p.intro(pc.bgCyan(pc.black(" claude resume ")));

    const selected = await pickSessionForResume(query, {
        list: opts.list,
        allProjects: opts.allProjects,
        limit: parseInt(opts.limit, 10) || 20,
    });
    await resumeSession(selected);
}

// --- Command Registration ---

export function registerResumeCommand(program: Command): void {
    program
        .command("resume")
        .description("Resume a Claude Code session by short ID, name, or content search")
        .argument("[query]", "Session ID prefix, name, or search term")
        .option("-l, --list", "List recent sessions")
        .option("-a, --all-projects", "Search all projects (default: current project only)")
        .option("-n, --limit <n>", "Number of sessions to show", "20")
        .action(async (query: string | undefined, opts: ResumeOptions) => {
            try {
                await main(query, opts);
            } catch (error) {
                if (error instanceof Error && (error.name === "ExitPromptError" || error.message === "Cancelled")) {
                    process.exit(0);
                }
                throw error;
            }
        });
}
