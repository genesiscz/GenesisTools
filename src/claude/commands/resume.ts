import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { warnUnresolvedIdentities } from "@genesiscz/utils/agent-sessions/history-cli";
import { createClaudeAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import type { AgentSearchHit, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import { cleanPromptText } from "@genesiscz/utils/ai/transcripts/clean-text";
import { findClaudeCommand } from "@genesiscz/utils/claude";
import { buildSessionTableOpts } from "@genesiscz/utils/claude/session-display";
import { isInteractive } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { formatClock, formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { expandPath } from "@genesiscz/utils/paths";
import { tableSelect } from "@genesiscz/utils/prompts/clack/table-select";
import { escapeShellArg } from "@genesiscz/utils/string";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
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
    created?: string;
    /** Friendly project name; `project` may hold the encoded transcript directory. */
    projectName?: string;
    source: "cache" | "search";
    firstPrompt: string;
    matchSnippet?: string;
    sourceHome?: string;
    sourceKey?: string;
    filePath?: string;
    cwd?: string;
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
        created?: string | null;
        source?: "cache" | "search";
        matchSnippet?: string;
    }
): DisplaySession {
    return {
        sessionId,
        // A raw title can BE a harness block: `<command-name>/resume</command-name>` over several
        // lines, which reads as garbage in the picker and breaks the row it is printed in.
        name:
            cleanPromptText(opts.title) ??
            cleanPromptText(opts.summary) ??
            cleanPromptText(opts.firstPrompt)?.slice(0, PROMPT_PREVIEW_LEN) ??
            "(unnamed)",
        summary: opts.summary || "",
        branch: opts.branch || "",
        project: opts.project || "",
        modified: opts.timestamp || "",
        created: opts.created ?? undefined,
        source: opts.source ?? "cache",
        firstPrompt: opts.firstPrompt || "",
        matchSnippet: opts.matchSnippet,
    };
}

function dedup(sessions: DisplaySession[]): DisplaySession[] {
    const seen = new Set<string>();
    return sessions.filter((s) => {
        const key = s.sourceKey ?? s.filePath ?? `${s.sourceHome ?? ""}:${s.sessionId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
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
    const q = query.trim().toLowerCase();
    const exact = all.filter(
        (s) => s.sessionId.toLowerCase() === q || s.sourceKey === query.trim() || s.filePath === query.trim()
    );
    if (exact.length) {
        return exact;
    }
    const byId = all.filter((s) => s.sessionId.toLowerCase().startsWith(q));
    if (byId.length > 0) {
        return byId;
    }

    const metadata = all.filter(
        (s) =>
            s.name.toLowerCase().includes(q) ||
            s.branch.toLowerCase().includes(q) ||
            s.project.toLowerCase().includes(q) ||
            s.firstPrompt.toLowerCase().includes(q)
    );
    if (metadata.length > 0) {
        return metadata;
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

/**
 * The query IS this session's identifier: an id prefix, a source key, a path, or its whole name.
 * Only those end the search. A SUBSTRING of a name is not identity — one session captured as
 * `/resume reports-02` is named after the query and would otherwise bury every real match.
 */
function identifiesSession(session: DisplaySession, query: string): boolean {
    const q = query.trim().toLowerCase();

    return (
        session.sessionId.toLowerCase().startsWith(q) ||
        session.sourceKey === query.trim() ||
        session.filePath === query.trim() ||
        session.name.trim().toLowerCase() === q ||
        normalizeAlphanumeric(session.name) === normalizeAlphanumeric(q)
    );
}

function displayNativeSession(session: AgentSearchHit): DisplaySession {
    return {
        ...toDisplay(session.sessionId, {
            title: session.title,
            summary: session.summary,
            firstPrompt: session.prompt,
            branch: session.gitBranch,
            project: session.projectDirectory ?? session.project,
            timestamp: session.mtime.toISOString(),
            created: session.createdAt?.toISOString(),
            source: session.matchedText ? "search" : "cache",
            matchSnippet: session.matchedText,
        }),
        projectName: session.project,
        sourceHome: session.sourceHome,
        sourceKey: session.sourceKey,
        filePath: session.filePath,
        cwd: session.cwd,
    };
}

export async function loadClaudeResumeCandidates(
    options: SessionPickOptions & { query?: string }
): Promise<DisplaySession[]> {
    const adapter = options.adapter ?? createClaudeAdapter();
    if (adapter.kind !== "claude") {
        throw new Error("Claude resume requires a Claude history provider");
    }

    // A short listing is annoying; a session that resume cannot find is the one that costs an
    // evening, because the user knows the conversation exists and has no reason to connect its
    // absence to a migration.
    await warnUnresolvedIdentities(adapter, "claude");
    const normalized = options.query?.trim().toLowerCase();
    const fullNativeId =
        normalized !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized);
    const allProjects = Boolean(options.allProjects || fullNativeId);
    const filters = {
        cwd: allProjects ? undefined : (options.cwd ?? process.cwd()),
        all: allProjects,
        excludeAgents: true,
    };
    // The limit bounds the REFRESH, which is what a plain list needs; it also bounds the rows that
    // come back, which is what a search must not accept.
    const listing = async (limit: number | undefined) =>
        dedup((await adapter.list({ ...filters, limit, summaryOnly: true })).map(displayNativeSession));
    const display = options.limit ?? 20;
    let sessions = await listing(display);

    /**
     * Every indexed session, for matching by id or name. Bounding this by the DISPLAY limit made
     * `-n` control recall: `resume handoff` returned 5 of 31 matches at the default 20, and the
     * sessions actually titled `handoff-v2` and `all-handoffs` were not among them, because one
     * weak match inside the recent window suppressed the wider pass entirely.
     *
     * Reading the cached metadata performs no discovery, sync or write, so completeness is cheap
     * here; the bounded `listing` above is what pays for freshness. An empty cache means nothing
     * is indexed yet, and only a full refresh can answer that.
     */
    async function everyIndexed(): Promise<DisplaySession[]> {
        const cached = adapter.listCached
            ? dedup((await adapter.listCached({ ...filters, summaryOnly: true })).map(displayNativeSession))
            : [];
        sessions = dedup([...(cached.length ? cached : await listing(Number.MAX_SAFE_INTEGER)), ...sessions]);

        return sessions;
    }

    if (fullNativeId) {
        const byId = (rows: DisplaySession[]) =>
            rows.filter((session) => session.sessionId.toLowerCase() === normalized);
        const found = byId(sessions);

        return found.length ? found : byId(await everyIndexed());
    }
    if (!options.query || options.list) {
        return sessions.slice(0, display);
    }
    const query = options.query;
    const rank = (rows: DisplaySession[]) =>
        rows.sort((a, b) => scoreContentMatch(b, query) - scoreContentMatch(a, query));
    const matches = matchByIdOrName(await everyIndexed(), query);

    if (matches.some((session) => identifiesSession(session, query))) {
        return rank(matches);
    }

    // A partial metadata hit does NOT stand in for the content pass. `--resume reports` matched
    // one session whose opening prompt says the word once, and that single hit suppressed the
    // search that finds the session whose transcript says it 207 times, so the session the user
    // wanted was never offered at all.
    const found = await adapter.search({
        ...filters,
        query,
        limit: options.limit ?? 20,
        sortByRelevance: true,
    });

    return rank(dedup([...matches, ...found.map(displayNativeSession)]));
}
// --- UI ---

/** Outside a TTY there is no picker, so the candidates have to be readable enough to choose from. */
function printAmbiguousCandidates(candidates: DisplaySession[], shown = 20): void {
    const table = createBoxTable(["#", "SESSION ID", "NAME", "CREATED", "AGE", "LAST PROMPT", "PROJECT"]);

    for (const [index, candidate] of candidates.slice(0, shown).entries()) {
        const created = candidate.created ? new Date(candidate.created) : undefined;
        const modified = candidate.modified ? new Date(candidate.modified) : undefined;
        table.push([
            String(index + 1),
            candidate.sessionId,
            truncateDisplay(candidate.name, 40),
            created ? formatClock(created, { date: "short" }) : "—",
            created ? formatRelativeTime(created) : "—",
            modified ? formatRelativeTime(modified) : "—",
            truncateDisplay(candidate.projectName || candidate.project, 24),
        ]);
    }

    out.println(table.toString());

    if (candidates.length > shown) {
        out.println(pc.dim(`… and ${candidates.length - shown} more; narrow the query to see them.`));
    }
}

export async function selectClaudeResumeSession({
    candidates,
    query,
    interactive = isInteractive(),
}: {
    candidates: DisplaySession[];
    query?: string;
    interactive?: boolean;
}): Promise<DisplaySession> {
    if (candidates.length === 0) {
        throw new Error(`No Claude sessions match${query ? ` "${query}"` : " this selection"}.`);
    }

    if (candidates.length === 1) {
        const s = candidates[0];
        p.log.info(
            `${pc.bold(s.name)} ${pc.dim(s.sessionId.slice(0, 8))} ${pc.magenta(s.branch)} ${s.project ? pc.blue(s.project) : ""}`
        );
        return s;
    }

    if (!interactive) {
        printAmbiguousCandidates(candidates);
        throw new Error(
            `Ambiguous Claude resume (${candidates.length} matches). Pass a session id from the table above, or use an interactive terminal.`
        );
    }

    const opts = buildSessionTableOpts(candidates, {
        message: "Select session to resume:",
        query,
    });

    for (const row of opts.rows) {
        const source = row.value as DisplaySession;
        row.detail = [
            ...(row.detail ?? []),
            ...(source.sourceHome ? [`Source home: ${source.sourceHome}`] : []),
            ...(source.filePath ? [`Source file: ${source.filePath}`] : []),
        ];
    }
    const result = await tableSelect(opts);

    if (!result) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return result;
}

/**
 * A recorded cwd is a historical fact, not a live path. On this machine 629 of 1,617 indexed
 * sessions (39%) name a removed worktree or a cleared scratch root, and `Bun.spawn` rejects a
 * missing cwd with an ENOENT that names the SHELL binary, not the directory:
 * `ENOENT: no such file or directory, posix_spawn '/bin/zsh'`. Resume then looked like a broken
 * shell for more than a third of all sessions.
 */
export function resumeDirectory(session: DisplaySession): { cwd: string; missing?: string } {
    const recorded = session.cwd;

    if (recorded && existsSync(recorded)) {
        return { cwd: recorded };
    }

    return { cwd: process.cwd(), ...(recorded ? { missing: recorded } : {}) };
}

async function resumeSession(session: DisplaySession): Promise<never> {
    if (!/^[\w-]+$/.test(session.sessionId)) {
        throw new Error(`Invalid session ID: ${session.sessionId}`);
    }

    const cmd = await findClaudeCommand();
    const directory = resumeDirectory(session);

    if (directory.missing) {
        out.log.warn(`Recorded directory is gone: ${directory.missing}. Starting in ${directory.cwd} instead.`);
    }

    p.outro(`${pc.green("Resuming:")} ${cmd} --resume ${session.sessionId}`);

    const shell = env.paths.getShell("/bin/sh");
    const proc = Bun.spawn({
        cmd: [shell, "-ic", `exec ${cmd} --resume '${session.sessionId}'`],
        cwd: directory.cwd,
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
    cwd?: string;
    adapter?: AgentSessionAdapter;
    interactive?: boolean;
}

/**
 * Interactive session selection (load → match → content-search → select).
 * Shared by `tools claude resume` and `tools claude start --resume <query>`.
 */
export async function pickSessionForResume(
    query: string | undefined,
    opts: SessionPickOptions = {}
): Promise<DisplaySession> {
    const spinner = p.spinner();
    // Named phases, because the transcript pass costs seconds on a large corpus and a spinner that
    // only says "synchronizing" for four of them reads as a hang.
    spinner.start("Searching Claude history: index, then transcripts...");
    let candidates: DisplaySession[];
    try {
        candidates = await loadClaudeResumeCandidates({ ...opts, query });
        spinner.stop(`${candidates.length} matching sessions`);
    } catch (error) {
        spinner.stop("History search failed");
        throw error;
    }
    const selected = await selectClaudeResumeSession({ candidates, query, interactive: opts.interactive });
    assertClaudeResumeHome({ session: selected });
    return selected;
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

export function assertClaudeResumeHome({
    session,
    effectiveHome = env.paths.getClaudeConfigDir() ?? join(homedir(), ".claude"),
}: {
    session: Pick<DisplaySession, "sourceHome" | "filePath" | "sessionId">;
    effectiveHome?: string;
}): void {
    if (!session.sourceHome) {
        return;
    }
    const canonical = (path: string) => {
        const expanded = expandPath(path);
        try {
            return realpathSync(expanded);
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return expanded;
            }
            throw error;
        }
    };
    if (canonical(session.sourceHome) === canonical(effectiveHome)) {
        return;
    }
    const command = `CLAUDE_CONFIG_DIR=${escapeShellArg(session.sourceHome)} tools claude resume ${escapeShellArg(session.filePath ?? session.sessionId)} --all-projects`;
    throw new Error(
        `This session belongs to ${session.sourceHome}, not the selected Claude home. No migration was performed. Resume explicitly with:\n${command}`
    );
}
