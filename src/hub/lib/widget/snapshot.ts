import { existsSync, statSync } from "node:fs";
import { sessionChangesPath } from "@app/agents/lib/changes/log";
import { type AgentSessionRow, listAgentSessionRows } from "@app/ai/lib/sessions/agent-session-rows";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { type DecisionRecord, kindOf, readDecisions } from "@app/question/lib/decisions/store";
import { INBOX_STALE_MS } from "@app/question/lib/inbox/build";
import { renderFormAnswer } from "@app/question/lib/pending/render";
import { listFormsSnapshot, PENDING_MIGRATIONS } from "@app/question/lib/pending/store";
import type { AskForm, AskItem } from "@app/question/lib/pending/types";
import { type QaRow, queryEntriesSnapshot, readQuestionSnapshot } from "@app/question/lib/read-model";
import type { TranscriptAnchor } from "@genesiscz/utils/agent/source-anchor";
import { resolveTranscript, transcriptEnvelope } from "@genesiscz/utils/ai/transcripts";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import type { ImageAttachment } from "@genesiscz/utils/image/attachments";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { workerSourceHome } from "@genesiscz/utils/worker/delivery";
import { hubAgents } from "../agents";
import type { AgentNode, AgentsTree } from "../agents/types";
import { readAssetManifest } from "../composer/serialize";
import { liftCardImages } from "./card-images";
import { WIDGET_DISCOVERY_REUSE_MS, WIDGET_ROSTER_HOURS, WIDGET_ROSTER_LIMIT } from "./roster-index";
import { readWidgetState } from "./storage";
import { parseWidgetSessionKey, shownOutgoing, type WidgetTarget, widgetSessionKey } from "./types";

const prof = profiler.scope("widget");

/** How long a quiet session's items keep counting in the badges: the hub's Inbox uses the same rule. */
export { INBOX_STALE_MS };

/**
 * Epoch milliseconds of a stored ISO time, or 0 when it is empty or malformed. A NaN here serializes as `null`, which
 * the native widget cannot decode into its `Double` fields, and it breaks the session and card sort.
 */
function timeOf(value: string | null | undefined): number {
    const at = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
}

export interface WidgetSession {
    key: string;
    target: WidgetTarget;
    title: string;
    project: string;
    activityAt: number;
    status: "working" | "waiting" | "finished" | "recent";
    pinned: boolean;
    visible: boolean;
    hiddenByFilter: boolean;
    parentSessionId?: string;
    agentId?: string;
    transcriptPath?: string;
    parentKey?: string;
    role?: string;
    model?: string;
    account?: string;
    startedAt?: number;
    toolCalls?: number;
    agentStatus?: string;
}
export interface WidgetCard {
    transcriptAnchor?: TranscriptAnchor;
    sourceContext?: {
        project?: string;
        cwd?: string;
        repoRoot?: string;
        branch?: string | null;
        commitSha?: string | null;
        isWorktree?: boolean;
        worktreePath?: string | null;
        sessionId: string;
        agent?: string;
        agentLabel?: string | null;
        aiAgent?: string | null;
    };
    id: string;
    kind: "decision" | "todo" | "form" | "answer" | "result";
    sessionKey: string;
    sourceId: string;
    at: number;
    title: string;
    body: string;
    status: string;
    revision?: number;
    number?: number;
    choices: { id: string; title: string; recommended: boolean }[];
    formItems?: AskItem[];
    formAnswers?: AskForm["answers"];
    attachments: ImageAttachment[];
    refs: { type: string; value: string }[];
    read: boolean;
    entryId?: string;
}
export interface WidgetSources {
    sessions(refresh: boolean): Promise<AgentSessionRow[]>;
    decisions(): DecisionRecord[];
    forms(session?: string): AskForm[];
    answers(session?: string): QaRow[];
    agents(refresh?: boolean): Promise<AgentsTree>;
    events?(ids: string[]): WidgetActivityEvent[];
    inboxData?(): WidgetInboxData;
    rosterStatus?(): { loading: boolean; error?: string };
}
export interface WidgetInboxGroup {
    id: string;
    sessionId: string;
    provider: string;
    title: string;
    project: string;
    cwd: string;
    at: number;
    count: number;
    total: number;
}
export interface WidgetInboxData {
    answers: WidgetInboxGroup[];
    forms: WidgetInboxGroup[];
    complete: boolean;
    truncated: boolean;
}
export interface WidgetInboxItem {
    id: string;
    sourceId: string;
    kind: "answer" | "result" | "decision" | "form";
    key: string;
    at: number;
    needsAnswer: boolean;
}
export interface WidgetInboxSession {
    key: string;
    unread: number;
    needsAnswer: number;
    latest?: WidgetInboxItem;
    unreadItem?: WidgetInboxItem;
    pendingItem?: WidgetInboxItem;
}
export interface WidgetInboxSummary {
    unread: number;
    needsAnswer: number;
    complete: boolean;
    truncated: boolean;
    sessions: WidgetInboxSession[];
    profile?: { hostId: "local" };
}

function readInboxData(): WidgetInboxData {
    return readQuestionSnapshot({
        dbPath: toolDataDir("question", "qa.db"),
        read: (db) => {
            runMigrations(db, PENDING_MIGRATIONS, { tableName: "qa_pending" });
            const answers = db
                .query<WidgetInboxGroup, []>(`
                WITH unseen AS (
                    SELECT id, COALESCE(NULLIF(session_id,''),id) AS sessionId,
                        CASE WHEN agent IN ('claude','claude-code') THEN 'claude'
                             WHEN agent IN ('codex','grok') THEN agent ELSE 'unknown' END AS provider,
                        COALESCE(session_title,session_id,id) AS title, COALESCE(project,'') AS project,
                        COALESCE(cwd,'') AS cwd, ts AS at,
                        COUNT(*) OVER () AS total
                    FROM entries WHERE read_at IS NULL AND superseded_by IS NULL
                        AND NOT EXISTS (SELECT 1 FROM qa_pending WHERE entry_id=entries.id)
                ), ranked AS (
                    SELECT *, COUNT(*) OVER (PARTITION BY sessionId,provider) AS count,
                        ROW_NUMBER() OVER (PARTITION BY sessionId,provider ORDER BY at DESC,id DESC) AS position
                    FROM unseen
                ) SELECT id,sessionId,provider,title,project,cwd,at,count,total
                  FROM ranked WHERE position=1 ORDER BY at DESC,id DESC LIMIT 257
            `)
                .all();
            const hasForms = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qa_pending'").get();
            const forms = hasForms
                ? db
                      .query<WidgetInboxGroup, []>(`
                WITH pending AS (
                    SELECT id, COALESCE(NULLIF(session_hint,''),id) AS sessionId,
                        CASE WHEN json_valid(poster_json) THEN NULLIF(json_extract(poster_json,'$.agent'),'unknown') END AS poster,
                        CASE WHEN json_valid(transcript_anchor_json) THEN json_extract(transcript_anchor_json,'$.provider') END AS anchor,
                        COALESCE(source,'Question') AS title, project_path AS project, cwd, created_at AS at,
                        COUNT(*) OVER () AS total
                    FROM qa_pending WHERE status='pending'
                ), normalized AS (
                    SELECT *, CASE WHEN COALESCE(poster,anchor) IN ('claude','claude-code') THEN 'claude'
                        WHEN COALESCE(poster,anchor) IN ('codex','grok') THEN COALESCE(poster,anchor)
                        ELSE 'unknown' END AS provider FROM pending
                ), ranked AS (
                    SELECT *, COUNT(*) OVER (PARTITION BY sessionId,provider) AS count,
                        ROW_NUMBER() OVER (PARTITION BY sessionId,provider ORDER BY at DESC,id DESC) AS position
                    FROM normalized
                ) SELECT id,sessionId,provider,title,project,cwd,at,count,total
                  FROM ranked WHERE position=1 ORDER BY at DESC,id DESC LIMIT 257
            `)
                      .all()
                : [];
            return {
                answers: answers.slice(0, 256),
                forms: forms.slice(0, 256),
                complete: true,
                truncated: answers.length > 256 || forms.length > 256,
            };
        },
    });
}

export interface WidgetActivityEvent {
    id: string;
    sourceId: string;
    at: number;
    title: string;
    body: string;
}
export function readWidgetDecisionEvents({
    ids,
    file = decisionFiles().events,
}: {
    ids: string[];
    file?: string;
}): WidgetActivityEvent[] {
    if (!ids.length || !existsSync(file)) {
        return [];
    }
    if (statSync(file).size > 16 * 1024 * 1024) {
        throw new Error("The Decision event ledger is too large for the widget; open the full ledger in Hub.");
    }
    const selected = new Set(ids);
    return readJsonlRows<unknown>(file)
        .rows.flatMap((row, index) => {
            if (
                typeof row !== "object" ||
                !row ||
                !("id" in row) ||
                typeof row.id !== "string" ||
                !selected.has(row.id) ||
                !("ts" in row) ||
                typeof row.ts !== "string" ||
                !("ev" in row) ||
                typeof row.ev !== "string"
            ) {
                return [];
            }
            const at = Date.parse(row.ts);
            if (!Number.isFinite(at)) {
                return [];
            }
            return [
                {
                    id: `${row.id}:${row.ts}:${index}`,
                    sourceId: row.id,
                    at,
                    title: `Decision ${row.ev}`,
                    body: ["state" in row ? String(row.state) : "", "route" in row ? String(row.route) : ""]
                        .filter(Boolean)
                        .join(" · "),
                },
            ];
        })
        .slice(-100);
}
let cachedAgents: { at: number; refreshed: boolean; promise: Promise<AgentsTree> } | undefined;
export function widgetAgents({ refresh = false }: { refresh?: boolean } = {}): Promise<AgentsTree> {
    if (!cachedAgents || Date.now() - cachedAgents.at > 15_000 || (refresh && !cachedAgents.refreshed)) {
        const promise = hubAgents({ hours: WIDGET_ROSTER_HOURS, limit: WIDGET_ROSTER_LIMIT, refresh });
        cachedAgents = { at: Date.now(), refreshed: refresh, promise };
        promise.catch((error) => {
            if (cachedAgents?.promise === promise) {
                cachedAgents = undefined;
            }
            logger.debug({ error }, "Widget roster cache could not refresh");
        });
    }
    return cachedAgents.promise;
}

/** The text blocks of one Claude JSONL line when it is an assistant message, else undefined. */
export function claudeAssistantText(line: string): string | undefined {
    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        logger.debug({ error }, "Widget result: skipped an unreadable transcript line");
        return undefined;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "assistant") {
        return undefined;
    }

    const message = "message" in parsed ? parsed.message : undefined;
    const content = message && typeof message === "object" && "content" in message ? message.content : undefined;
    if (typeof content === "string") {
        return content.trim() || undefined;
    }

    if (!Array.isArray(content)) {
        return undefined;
    }

    const texts = content.flatMap((block: unknown) =>
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
            ? [block.text]
            : []
    );
    return texts.join("\n").trim() || undefined;
}

/**
 * The last assistant text of a Claude transcript, read from the end of the file: the result of a 300 MB lead costs a
 * few hundred KB instead of a whole parse. Grows the window until it finds one or has read the whole file.
 */
export async function lastClaudeAssistantText(filePath: string, size: number): Promise<string> {
    for (const bytes of [256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024]) {
        const lines = await readTailBytes(filePath, bytes);
        for (let index = lines.length - 1; index >= 0; index--) {
            const text = claudeAssistantText(lines[index]);
            if (text) {
                return text;
            }
        }

        if (bytes >= size) {
            break;
        }
    }

    return "";
}

const resultCache = new Map<string, { mtime: number; text: string }>();
async function widgetResult(node: AgentNode): Promise<string> {
    if (!node.filePath || !existsSync(node.filePath)) {
        return "";
    }
    const stat = statSync(node.filePath);
    const cached = resultCache.get(node.filePath);
    if (cached?.mtime === stat.mtimeMs) {
        return cached.text;
    }
    // A large transcript used to show "open Conversation or Hub": the widget must show the result itself.
    let text: string;
    if (stat.size > 8 * 1024 * 1024 && node.harness === "claude") {
        text = (await lastClaudeAssistantText(node.filePath, stat.size)).slice(0, 32_000);
    } else if (stat.size > 8 * 1024 * 1024) {
        text = "";
    } else {
        const resolved = await resolveTranscript(node.filePath, {}, node.harness);
        const envelope = await transcriptEnvelope(resolved, { limit: 20 });
        text =
            envelope.turns.findLast((turn) => turn.role === "assistant" && turn.text.trim())?.text.slice(0, 32_000) ??
            "";
    }
    if (resultCache.size >= 100) {
        resultCache.clear();
    }
    resultCache.set(node.filePath, { mtime: stat.mtimeMs, text });
    return text;
}
/**
 * Pending forms for the roster, or one session's form timeline. An unhinted form is its own session, keyed by its
 * form id, so selecting that session must find the form by id as well as by session hint.
 */
export function widgetForms({ dbPath, sessionHint }: { dbPath: string; sessionHint?: string }): AskForm[] {
    return listFormsSnapshot({
        dbPath,
        opts: sessionHint ? { sessionHint, includeUnhintedFormId: true, limit: 80 } : { status: "pending", limit: 250 },
    });
}
export const realWidgetSources: WidgetSources = {
    sessions: (refresh) =>
        listAgentSessionRows({
            hours: WIDGET_ROSTER_HOURS,
            withUsage: false,
            refresh,
            maxDiscoveryAgeMs: WIDGET_DISCOVERY_REUSE_MS,
            failClosed: true,
        }),
    decisions: () => readDecisions(decisionFiles().file),
    forms: (sessionHint) => widgetForms({ dbPath: toolDataDir("question", "qa.db"), sessionHint }),
    answers: (sessionId) =>
        queryEntriesSnapshot({
            dbPath: toolDataDir("question", "qa.db"),
            // The notified answer can sit behind 80 newer read ones; opening it must still find its card.
            opts: sessionId ? { sessionId, limit: 80, includeNewestUnread: true } : { limit: 100 },
        }),
    agents: (refresh) => widgetAgents({ refresh }),
    inboxData: readInboxData,
    events: (ids) => readWidgetDecisionEvents({ ids }),
};

/** Refreshes both catalogs the Widget reads: indexed sessions and the agent roster, which the sessions scope excludes. */
export async function discoverWidgetCatalog(
    sources: Pick<WidgetSources, "agents" | "sessions"> = realWidgetSources
): Promise<{ sessions: number; agents: number }> {
    const [sessions, tree] = await Promise.all([sources.sessions(true), sources.agents(true)]);
    return { sessions: sessions.length, agents: tree.parents.length + tree.orphans.length };
}

/** The provider name a Widget session key carries: unsupported agents become "unknown". */
export function widgetProvider(value: string | null | undefined): WidgetTarget["provider"] {
    if (value === "claude" || value === "claude-code") {
        return "claude";
    }
    return value === "codex" || value === "grok" ? value : "unknown";
}
function formProvider(form: AskForm): string | undefined {
    if (form.poster?.agent && form.poster.agent !== "unknown") {
        return form.poster.agent;
    }
    return form.transcriptAnchor && form.transcriptAnchor.kind !== "unanchored"
        ? form.transcriptAnchor.provider
        : undefined;
}

function targetOf(
    row: { provider?: string | null; sessionId?: string | null; sourceHome?: string; cwd?: string | null },
    fallback: string
): WidgetTarget {
    return {
        hostId: "local",
        provider: widgetProvider(row.provider),
        sessionId: row.sessionId || fallback,
        sourceHome: row.sourceHome ?? "",
        cwd: row.cwd ?? "",
    };
}
function cleanVisibleContext(text: string): string {
    return text.replace(/<from(?:Image|Video)>[\s\S]*?<\/from(?:Image|Video)>/g, "").trim();
}

/** `body` without its first line when that line is the card title, so a message does not repeat its own title. */
function withoutLeadingLine(body: string, title: string): string {
    const [first = "", ...rest] = body.split("\n");

    if (first.replace(/^#{1,6}\s+/, "").trim() !== title.trim()) {
        return body;
    }

    return rest.join("\n").trim();
}
function flattenAgents(nodes: AgentNode[]): AgentNode[] {
    return nodes.flatMap((node) => [node, ...flattenAgents(node.children)]);
}

/** Only a finished agent has a result; an idle teammate or a ready worker is still part of the work. */
function hasResult(node: AgentNode): boolean {
    return node.status === "completed" || node.status === "failed" || node.status === "killed";
}

/**
 * The finished agent an inbox read names, when it still belongs to that Widget session: either the
 * session is the agent's own (`sessionId` is the agent id or its native session id), or it is the indexed session whose
 * transcript is the agent's file, which is how the snapshot maps a worker onto an indexed row.
 */
export async function widgetResultNode({
    target,
    agentId,
    sources = realWidgetSources,
}: {
    target: WidgetTarget;
    agentId: string;
    sources?: Pick<WidgetSources, "agents" | "sessions">;
}): Promise<AgentNode | undefined> {
    const tree = await sources.agents(false);
    const node = [...tree.parents.flatMap((parent) => flattenAgents(parent.children)), ...flattenAgents(tree.orphans)]
        .filter(
            (entry) => entry.id === agentId && widgetProvider(entry.harness) === target.provider && hasResult(entry)
        )
        .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))[0];
    const ownNative =
        node?.nativeSessionId === target.sessionId &&
        (!node.sourceHome || workerSourceHome(node.sourceHome) === workerSourceHome(target.sourceHome));
    if (!node || node.id === target.sessionId || ownNative) {
        return node;
    }

    if (!node.filePath) {
        return undefined;
    }

    const rows = await sources.sessions(false);
    const owned = rows.some(
        (row) =>
            row.sessionId === target.sessionId &&
            widgetProvider(row.provider) === target.provider &&
            row.filePath === node.filePath
    );
    return owned ? node : undefined;
}

type WidgetChanges = { available: boolean; files: { path: string; at: string; source: string }[] };

/**
 * The last parse of each change ledger, by path, with the file identity it was read at. The widget refreshes every
 * five seconds; an unchanged ledger (up to 16 MiB) is answered from here instead of being parsed again.
 */
const changesCache = new Map<string, { identity: string; sessionId: string; result: WidgetChanges }>();
const CHANGES_CACHE_LIMIT = 16;

export function readWidgetChanges({
    target,
    path = sessionChangesPath(target.sessionId),
}: {
    target: WidgetTarget;
    path?: string;
}): WidgetChanges {
    if (!existsSync(path)) {
        changesCache.delete(path);
        return { available: false, files: [] };
    }
    const stat = statSync(path, { bigint: true });
    if (stat.size > 16n * 1024n * 1024n) {
        throw new Error("Change receipt is too large for the widget; open it in Hub");
    }

    const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = changesCache.get(path);
    if (cached && cached.identity === identity && cached.sessionId === target.sessionId) {
        return cached.result;
    }

    const result = parseWidgetChanges(path, target);
    changesCache.delete(path);
    changesCache.set(path, { identity, sessionId: target.sessionId, result });
    if (changesCache.size > CHANGES_CACHE_LIMIT) {
        const oldest = changesCache.keys().next().value;
        if (oldest !== undefined) {
            changesCache.delete(oldest);
        }
    }

    return result;
}

function parseWidgetChanges(path: string, target: WidgetTarget): WidgetChanges {
    const rows = readJsonlRows<unknown>(path).rows;
    const files = new Map<string, { path: string; at: string; source: string }>();
    for (const row of rows) {
        if (
            typeof row !== "object" ||
            !row ||
            !("session" in row) ||
            row.session !== target.sessionId ||
            !("path" in row) ||
            typeof row.path !== "string" ||
            !("ts" in row) ||
            typeof row.ts !== "string"
        ) {
            continue;
        }
        files.set(row.path, { path: row.path, at: row.ts, source: "source" in row ? String(row.source) : "recorded" });
    }
    return { available: true, files: [...files.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100) };
}

export async function widgetSnapshot({
    root,
    selectedKey,
    refresh = false,
    sources = realWidgetSources,
    now = Date.now(),
}: {
    root?: string;
    selectedKey?: string;
    refresh?: boolean;
    sources?: WidgetSources;
    /** The clock the inbox ages items against; tests pass a fixed one. */
    now?: number;
}) {
    const state = await readWidgetState(root);
    selectedKey ??= state.selectedKey ?? undefined;
    /** An item still matters while it is recent or its session worked lately; a session can be "working" with old items. */
    const inboxFresh = (session: WidgetSession, at: number) =>
        session.status === "working" || Math.max(at, session.activityAt) >= now - INBOX_STALE_MS;
    /** Counted in the badges: fresh, and newer than the user's last "Mark all read". Every item stays in its session. */
    const inboxCounted = (session: WidgetSession, at: number) =>
        at > (state.inboxClearedAt ?? 0) && inboxFresh(session, at);
    const errors: string[] = [];
    const rosterStatus = sources.rosterStatus?.();
    if (rosterStatus?.error) {
        errors.push(`Agent list: ${rosterStatus.error}. Showing the last completed list.`);
    }
    async function read<T>(name: string, fn: () => T | Promise<T>, fallback: T): Promise<T> {
        const stop = prof.start(name);
        try {
            const value = fn();
            return value instanceof Promise ? await value : value;
        } catch (error) {
            logger.warn({ error, name }, "Widget source unavailable");
            errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            return fallback;
        } finally {
            stop();
        }
    }
    const [rows, decisions, waitingForms, agents, answerRoster] = await Promise.all([
        read("sessions", () => sources.sessions(refresh), []),
        read("decisions", sources.decisions, []),
        read("questions", () => sources.forms(), []),
        read("agents", () => sources.agents(refresh), { generatedAt: "", parents: [], orphans: [] }),
        read("answer sessions", () => sources.answers(), []),
    ]);
    const inboxData = sources.inboxData
        ? await read("inbox metadata", sources.inboxData, { answers: [], forms: [], complete: false, truncated: false })
        : {
              answers: answerRoster
                  .filter((row) => row.readAt === null)
                  .map((row) => ({
                      id: row.id,
                      sessionId: row.sessionId,
                      provider: widgetProvider(row.agent),
                      title: row.sessionTitle ?? row.sessionId,
                      project: row.project,
                      cwd: row.cwd,
                      at: row.ts,
                      count: 1,
                      total: answerRoster.filter((entry) => entry.readAt === null).length,
                  })),
              forms: waitingForms.map((form) => ({
                  id: form.id,
                  sessionId: form.sessionHint || form.id,
                  provider: formProvider(form) ?? "unknown",
                  title: form.source ?? "Question",
                  project: form.projectPath,
                  cwd: form.cwd,
                  at: form.createdAt,
                  count: 1,
                  total: waitingForms.length,
              })),
              complete: false,
              truncated: true,
          };
    const sessions = new Map<string, WidgetSession>();
    const addSession = (target: WidgetTarget, title: string, project: string, activityAt: number): WidgetSession => {
        const key = widgetSessionKey(target);
        const existing = sessions.get(key);
        if (existing) {
            return existing;
        }
        const hiddenByFilter =
            (state.preferences.projects.length > 0 && !state.preferences.projects.includes(target.cwd)) ||
            (state.preferences.sessions.length > 0 && !state.preferences.sessions.includes(key)) ||
            (state.preferences.providers.length > 0 && !state.preferences.providers.includes(target.provider));
        const pinned = !state.preferences.excludedKeys.includes(key);
        const entry: WidgetSession = {
            key,
            target,
            title,
            project,
            activityAt,
            status: "recent",
            pinned,
            visible: pinned && !hiddenByFilter,
            hiddenByFilter,
        };
        sessions.set(key, entry);
        return entry;
    };
    for (const row of rows) {
        if (!row.archived) {
            const session = addSession(
                targetOf(row, row.sessionId),
                row.title ?? row.sessionId,
                row.project ?? row.cwd,
                row.mtime
            );
            session.transcriptPath = row.filePath;
            session.model = row.model ?? undefined;
            session.account = row.account ?? undefined;
        }
    }
    const findSession = (id: string, hint?: string | null) => {
        const matches = [...sessions.values()].filter(
            (entry) => entry.target.sessionId === id && (!hint || entry.target.provider === widgetProvider(hint))
        );
        return matches.length === 1 ? matches[0] : undefined;
    };
    // A worker reusing an indexed session keeps that session's id; `agentId` is what names the worker then.
    const findResultSession = (node: AgentNode) =>
        [...sessions.values()].find(
            (entry) => entry.agentId === node.id && entry.target.provider === widgetProvider(node.harness)
        ) ?? findSession(node.id, node.harness);
    const addWorker = (node: AgentNode, parent?: WidgetSession) => {
        // A codex/grok worker's id is its name; replies reach it only through its native session and home.
        const sessionId = node.nativeSessionId || node.id;
        // The same session id is indexed once per home; only the copy in the worker's own home is the worker.
        const home = node.sourceHome ? workerSourceHome(node.sourceHome) : undefined;
        const indexed = [...sessions.values()].filter(
            (entry) =>
                entry.target.provider === node.harness &&
                (node.nativeSessionId
                    ? entry.target.sessionId === node.nativeSessionId &&
                      (!home || workerSourceHome(entry.target.sourceHome) === home)
                    : node.filePath
                      ? entry.transcriptPath === node.filePath
                      : entry.target.sessionId === node.id)
        );
        const target = targetOf(
            {
                provider: node.harness,
                sessionId,
                cwd: parent?.target.cwd,
                sourceHome:
                    node.sourceHome ||
                    (parent?.target.provider === node.harness ? parent.target.sourceHome : undefined),
            },
            sessionId
        );
        const session =
            indexed.length === 1
                ? indexed[0]
                : addSession(
                      target,
                      node.name ?? node.description ?? node.id,
                      parent?.project ?? "Agent",
                      timeOf(node.lastAt)
                  );
        session.title = node.name ?? node.description ?? session.title;
        session.status = node.status === "running" ? "working" : node.status === "completed" ? "finished" : "recent";
        session.agentId = node.id;
        session.parentSessionId = parent?.target.sessionId;
        session.parentKey = parent?.key;
        session.transcriptPath = node.filePath ?? undefined;
        session.role = node.kind;
        session.model = node.model ?? session.model;
        session.account = node.account ?? session.account;
        session.toolCalls = node.toolCalls;
        session.agentStatus = node.status;
        const startedAt = Date.parse(node.startedAt ?? "");
        if (Number.isFinite(startedAt)) {
            session.startedAt = startedAt;
        }
        for (const child of node.children) {
            addWorker(child, session);
        }
        return session;
    };
    for (const parent of agents.parents) {
        const session =
            findSession(parent.sessionId, parent.provider) ??
            addSession(
                targetOf(parent, parent.sessionId),
                parent.title ?? parent.sessionId,
                parent.project ?? parent.cwd,
                timeOf(parent.lastAt)
            );
        session.transcriptPath ??= parent.filePath;
        session.role = "lead";
        session.model = parent.model ?? session.model;
        session.account = parent.account ?? session.account;
        session.agentStatus = parent.live ? "running" : "idle";
        const startedAt = Date.parse(parent.startedAt ?? "");
        if (Number.isFinite(startedAt)) {
            session.startedAt = startedAt;
        }
        const nodes = flattenAgents(parent.children);
        for (const node of parent.children) {
            addWorker(node, session);
        }
        if (parent.live || nodes.some((node) => node.status === "running")) {
            session.status = "working";
        }
    }
    for (const node of agents.orphans) {
        addWorker(node);
    }
    for (const decision of decisions) {
        const session =
            findSession(decision.sessionId, decision.provider) ??
            addSession(
                targetOf({ ...decision, sessionId: decision.sessionId }, decision.id),
                decision.sessionTitle ?? decision.sessionId,
                decision.project ?? decision.cwd ?? "",
                timeOf(decision.updatedTs)
            );
        if (
            kindOf(decision) === "decision" &&
            ["open", "drafted"].includes(decision.state) &&
            inboxFresh(session, timeOf(decision.updatedTs))
        ) {
            session.status = "waiting";
        }
    }
    for (const form of waitingForms) {
        const session = form.sessionHint ? findSession(form.sessionHint, formProvider(form)) : undefined;
        const current =
            session ??
            addSession(
                targetOf({ sessionId: form.sessionHint, cwd: form.cwd, provider: formProvider(form) }, form.id),
                form.source ?? "Agent question",
                form.projectPath,
                form.createdAt
            );
        current.status = "waiting";
    }
    for (const row of answerRoster) {
        if (!findSession(row.sessionId, row.agent === "unknown" ? undefined : row.agent)) {
            addSession(
                targetOf({ sessionId: row.sessionId, provider: row.agent, cwd: row.cwd }, row.id),
                row.sessionTitle ?? row.sessionId,
                row.project,
                row.ts
            );
        }
    }
    for (const message of state.outgoing) {
        addSession(message.target, message.target.sessionId, message.target.cwd, message.createdAt);
    }
    for (const [key, draft] of Object.entries(state.drafts)) {
        const target = parseWidgetSessionKey(key);
        if (target && (draft.text || draft.assetIds.length)) {
            addSession(target, target.sessionId, target.cwd, 0);
        }
    }
    const inboxSessions = new Map<string, WidgetInboxSession>();
    const putInbox = (session: WidgetSession, item: WidgetInboxItem, count: number) => {
        const entry = inboxSessions.get(session.key) ?? { key: session.key, unread: 0, needsAnswer: 0 };
        if (item.needsAnswer) {
            entry.needsAnswer += count;
        } else {
            entry.unread += count;
        }
        if (
            !entry.latest ||
            (item.needsAnswer && !entry.latest.needsAnswer) ||
            (item.needsAnswer === entry.latest.needsAnswer && item.at > entry.latest.at)
        ) {
            entry.latest = item;
        }
        const target = item.needsAnswer ? "pendingItem" : "unreadItem";
        if (!entry[target] || item.at > entry[target].at) {
            entry[target] = item;
        }
        inboxSessions.set(session.key, entry);
    };
    // Counted per group: the SQL groups carry their session's count and newest item, and `total` also covers groups
    // past the row limit, so each group left out of the count is subtracted from it.
    const skipped = { answer: 0, form: 0 };
    for (const [kind, groups] of [
        ["answer", inboxData.answers],
        ["form", inboxData.forms],
    ] as const) {
        for (const row of groups) {
            // "unknown" is the SQL fallback, not evidence: match by session id alone, as the card loops do.
            const session =
                findSession(row.sessionId, row.provider === "unknown" ? undefined : row.provider) ??
                addSession(
                    targetOf({ sessionId: row.sessionId, provider: row.provider, cwd: row.cwd }, row.id),
                    row.title,
                    row.project,
                    row.at
                );
            if (kind === "form" && inboxFresh(session, row.at)) {
                session.status = "waiting";
            }
            if (!inboxCounted(session, row.at)) {
                skipped[kind] += row.count;
                continue;
            }
            putInbox(
                session,
                {
                    id: `${kind}:${row.id}`,
                    sourceId: row.id,
                    kind,
                    key: session.key,
                    at: row.at,
                    needsAnswer: kind === "form",
                },
                row.count
            );
        }
    }
    let pendingDecisions = 0;
    for (const row of decisions) {
        if (kindOf(row) !== "decision" || !["open", "drafted"].includes(row.state) || row.delivery?.uncertain) {
            continue;
        }
        const session = findSession(row.sessionId, row.provider);
        if (!session || !inboxCounted(session, timeOf(row.updatedTs))) {
            continue;
        }
        pendingDecisions += 1;
        putInbox(
            session,
            {
                id: `decision:${row.id}`,
                sourceId: row.id,
                kind: "decision",
                key: session.key,
                at: timeOf(row.updatedTs),
                needsAnswer: true,
            },
            1
        );
    }
    let unreadResults = 0;
    const resultNodes = new Map<string, AgentNode>();
    for (const node of [
        ...agents.parents.flatMap((parent) => flattenAgents(parent.children)),
        ...flattenAgents(agents.orphans),
    ]) {
        const id = `${node.harness}:${node.id}`;
        const previous = resultNodes.get(id);
        if (!previous || Date.parse(node.lastAt) > Date.parse(previous.lastAt)) {
            resultNodes.set(id, node);
        }
    }
    for (const node of resultNodes.values()) {
        if (!hasResult(node)) {
            continue;
        }
        const session = findResultSession(node);
        const at = Date.parse(node.lastAt);
        if (!session || !Number.isFinite(at)) {
            continue;
        }
        const id = `result:${node.harness}:${node.id}`;
        if ((state.inboxRead[`${session.key}|${id}`] ?? -1) >= at || !inboxCounted(session, at)) {
            continue;
        }
        unreadResults += 1;
        putInbox(session, { id, sourceId: node.id, kind: "result", key: session.key, at, needsAnswer: false }, 1);
    }
    const notifications: WidgetInboxSummary = {
        unread: Math.max(0, (inboxData.answers[0]?.total ?? 0) - skipped.answer) + unreadResults,
        needsAnswer: Math.max(0, (inboxData.forms[0]?.total ?? 0) - skipped.form) + pendingDecisions,
        complete: inboxData.complete && errors.length === 0,
        truncated: inboxData.truncated || inboxSessions.size > 512,
        sessions: [...inboxSessions.values()]
            .sort((a, b) => b.needsAnswer - a.needsAnswer || b.unread - a.unread)
            .slice(0, 512),
        ...(prof.enabled ? { profile: { hostId: "local" as const } } : {}),
    };
    const inboxMetadata: { notifications?: WidgetInboxSummary } = { notifications };
    const selected = selectedKey ? sessions.get(selectedKey) : undefined;
    const persistedTarget = selectedKey ? parseWidgetSessionKey(selectedKey) : undefined;
    const selectedId = selected?.target.sessionId ?? persistedTarget?.sessionId;
    const [answers, forms] = await Promise.all([
        selectedId ? read("answers", () => sources.answers(selectedId), []) : Promise.resolve(answerRoster),
        selectedId ? read("question timeline", () => sources.forms(selectedId), []) : Promise.resolve(waitingForms),
    ]);
    for (const form of forms) {
        const id = form.sessionHint || form.id;
        const sourceProvider = formProvider(form);
        if (!findSession(id, sourceProvider)) {
            const identity =
                persistedTarget?.sessionId === id &&
                (!sourceProvider || persistedTarget.provider === widgetProvider(sourceProvider))
                    ? persistedTarget
                    : targetOf({ sessionId: id, provider: sourceProvider }, form.id);
            const session = addSession(
                { ...identity, cwd: form.cwd },
                form.source ?? id,
                form.projectPath,
                form.resolvedAt ?? form.createdAt
            );
            session.status = form.status === "pending" ? "waiting" : "recent";
        }
    }
    const cards: WidgetCard[] = [];
    const formEntries = new Set(forms.flatMap((form) => (form.entryId ? [form.entryId] : [])));
    for (const row of answers) {
        if (formEntries.has(row.id)) {
            continue;
        }
        const session =
            findSession(row.sessionId, row.agent === "unknown" ? undefined : row.agent) ??
            addSession(
                targetOf({ sessionId: row.sessionId, provider: row.agent, cwd: row.cwd }, row.id),
                row.sessionTitle ?? row.sessionId,
                row.project,
                row.ts
            );
        const answerImages = liftCardImages([row.question, cleanVisibleContext(row.answerMd)], row.attachments ?? []);
        const [answerTitle, answerBody] = answerImages.texts;
        cards.push({
            id: `answer:${row.id}`,
            kind: "answer",
            transcriptAnchor: row.transcriptAnchor,
            sourceContext: {
                sessionId: row.sessionId,
                agent: row.agent,
                agentLabel: row.agentLabel,
                aiAgent: row.aiAgent,
                project: row.project,
                cwd: row.cwd,
                repoRoot: row.repoRoot,
                branch: row.branch,
                commitSha: row.commitSha,
                isWorktree: row.isWorktree,
                worktreePath: row.worktreePath,
            },
            sessionKey: session.key,
            sourceId: row.id,
            at: row.ts,
            title: answerTitle,
            // A message's title is usually its own first line (src/question/lib/message.ts); it is not repeated.
            body: row.tag === "message" ? withoutLeadingLine(answerBody, answerTitle) : answerBody,
            status: row.tag === "message" ? "message" : "answered",
            choices: [],
            attachments: answerImages.attachments,
            refs: row.refs,
            read: row.readAt !== null,
        });
    }
    for (const row of decisions) {
        const session = findSession(row.sessionId, row.provider);
        if (!session || (selectedKey && session.key !== selectedKey)) {
            continue;
        }
        // The prompt is lifted too: an item's attachments are embedded there, and with a title it is not drawn.
        const decisionImages = liftCardImages([
            row.title ?? row.prompt,
            cleanVisibleContext(
                [row.context, row.reasoning, row.proposal, row.answer, row.notes].filter(Boolean).join("\n\n")
            ),
            ...(row.title ? [row.prompt] : []),
        ]);
        const [decisionTitle, decisionBody] = decisionImages.texts;
        cards.push({
            id: `decision:${row.id}`,
            kind: kindOf(row),
            transcriptAnchor: row.transcriptAnchor,
            sourceContext: {
                sessionId: row.sessionId,
                agent: row.provider,
                aiAgent: row.aiAgent,
                project: row.project,
                cwd: row.cwd,
                repoRoot: row.repoRoot,
                branch: row.branch,
                commitSha: row.commitSha,
                isWorktree: row.isWorktree,
                worktreePath: row.worktreePath,
            },
            sessionKey: session.key,
            sourceId: row.id,
            at: timeOf(row.updatedTs),
            title: decisionTitle,
            body: decisionBody,
            status: row.delivery?.uncertain ? "delivery unknown" : row.state,
            number: row.number,
            revision: row.revision ?? 1,
            choices: row.options.map((title, index) => ({
                id: String.fromCharCode(97 + index),
                title,
                recommended: row.recommended === String.fromCharCode(97 + index),
            })),
            attachments: decisionImages.attachments,
            refs: (row.refs ?? []).map((ref) => ({ type: "file", value: ref.path })),
            read: true,
        });
    }
    for (const form of forms) {
        const session =
            (form.sessionHint ? findSession(form.sessionHint, formProvider(form)) : undefined) ??
            [...sessions.values()].find((entry) => entry.target.sessionId === form.id);
        if (!session || (selectedKey && session.key !== selectedKey)) {
            continue;
        }
        // Each item's prompt is drawn by the form view, so the lifted images leave the prompts the widget receives.
        const formImages = liftCardImages([
            form.status === "answered" ? cleanVisibleContext(renderFormAnswer(form, form.answers ?? {})) : "",
            ...form.items.map((item) => item.promptMarkdown),
        ]);
        const [formAnswer, ...formPrompts] = formImages.texts;
        const formItems = form.items.map((item, index) => ({ ...item, promptMarkdown: formPrompts[index] ?? "" }));
        cards.push({
            id: `form:${form.id}`,
            kind: "form",
            transcriptAnchor: form.transcriptAnchor,
            sourceContext: form.poster
                ? {
                      ...form.poster,
                      sessionId: form.sessionHint ?? form.poster.sessionId ?? "unknown",
                  }
                : undefined,
            sessionKey: session.key,
            sourceId: form.id,
            at: form.resolvedAt ?? form.createdAt,
            title: formItems[0]?.promptMarkdown || "Question",
            body:
                form.status === "answered"
                    ? formAnswer
                    : form.items.length > 1
                      ? `${String(form.items.length)} questions`
                      : "",
            status: form.status,
            choices: [],
            formItems,
            formAnswers: form.answers,
            attachments: formImages.attachments,
            refs: [],
            read: form.status !== "pending",
            entryId: form.entryId,
        });
    }
    for (const node of [
        ...agents.parents.flatMap((parent) => flattenAgents(parent.children)),
        ...flattenAgents(agents.orphans),
    ]) {
        const session = findResultSession(node);
        if (!session || !hasResult(node) || (selectedKey && session.key !== selectedKey)) {
            continue;
        }
        const result = selectedKey ? await read("agent result", () => widgetResult(node), "") : "";
        const resultImages = liftCardImages([
            result ||
                `Task context: ${node.spawnPromptPreview ?? node.description ?? "Open the conversation to read the agent's result."}`,
        ]);
        cards.push({
            id: `result:${node.harness}:${node.id}`,
            kind: "result",
            sessionKey: session.key,
            sourceId: node.id,
            at: timeOf(node.lastAt),
            title: node.name ?? node.description ?? node.id,
            body: resultImages.texts[0],
            status: node.status,
            choices: [],
            attachments: resultImages.attachments,
            refs: node.filePath ? [{ type: "file", value: node.filePath }] : [],
            read:
                Math.max(
                    state.inboxRead[`${session.key}|result:${node.harness}:${node.id}`] ?? -1,
                    state.inboxClearedAt ?? -1
                ) >= Date.parse(node.lastAt),
        });
    }
    // Only the videos the widget can show: those in a draft, and those of the selected session's shown outgoing
    // messages (the list WidgetModel.outgoing draws). Every ready video ever imported stays in state, and each
    // manifest holds up to 2,400 frames, so reading them all made every five-second refresh grow with history.
    const shown = new Set(Object.values(state.drafts).flatMap((draft) => draft.assetIds));
    const recent = selected
        ? shownOutgoing(state.outgoing.filter((message) => widgetSessionKey(message.target) === selected.key))
        : [];
    for (const message of recent) {
        for (const id of message.assetIds) {
            shown.add(id);
        }
    }
    const manifests: Record<string, unknown> = {};
    for (const asset of Object.values(state.assets)) {
        if (asset.type === "video" && asset.status === "ready" && shown.has(asset.id)) {
            const manifest = await read(`video ${asset.id}`, () => readAssetManifest(asset), null);
            if (manifest) {
                manifests[asset.id] = manifest;
            }
        }
    }
    const changes =
        selected && state.preferences.showChanges
            ? await read("changes", () => readWidgetChanges({ target: selected.target }), {
                  available: false,
                  files: [],
              })
            : null;
    // The window keeps the newest cards plus each card a notification names, so opening it can acknowledge it.
    const selectedCards = cards
        .filter((card) => !selectedKey || card.sessionKey === selectedKey)
        .sort((a, b) => a.at - b.at);
    const notified = new Set(
        notifications.sessions.flatMap((session) => [session.unreadItem?.id, session.pendingItem?.id])
    );
    const windowStart = Math.max(0, selectedCards.length - 100);
    const visibleCards = selectedCards.filter((card, index) => index >= windowStart || notified.has(card.id));
    const activity =
        selectedId && sources.events
            ? await read(
                  "Decision activity",
                  () => sources.events!(decisions.filter((row) => row.sessionId === selectedId).map((row) => row.id)),
                  []
              )
            : [];
    return {
        version: 1,
        state,
        ...inboxMetadata,
        ...(rosterStatus ? { rosterLoading: rosterStatus.loading } : {}),
        activity,
        sessions: [...sessions.values()].sort(
            (a, b) => Number(b.status === "waiting") - Number(a.status === "waiting") || b.activityAt - a.activityAt
        ),
        cards: visibleCards,
        manifests,
        changes,
        errors,
        selectedKey: selectedKey ?? null,
    };
}
