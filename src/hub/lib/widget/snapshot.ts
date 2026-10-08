import { existsSync, statSync } from "node:fs";
import { sessionChangesPath } from "@app/agents/lib/changes/log";
import { type AgentSessionRow, listAgentSessionRows } from "@app/ai/lib/sessions/agent-session-rows";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { type DecisionRecord, kindOf, readDecisions } from "@app/question/lib/decisions/store";
import { renderFormAnswer } from "@app/question/lib/pending/render";
import { listForms, openPendingStore } from "@app/question/lib/pending/store";
import type { AskForm, AskItem } from "@app/question/lib/pending/types";
import { openReadModel, type QaRow, queryEntries } from "@app/question/lib/read-model";
import { resolveTranscript, transcriptEnvelope } from "@genesiscz/utils/ai/transcripts";
import type { ImageAttachment } from "@genesiscz/utils/image/attachments";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { hubAgents } from "../agents";
import type { AgentNode, AgentsTree } from "../agents/types";
import { readAssetManifest } from "../composer/serialize";
import { readWidgetState } from "./storage";
import { parseWidgetSessionKey, type WidgetTarget, widgetSessionKey } from "./types";

const prof = profiler.scope("widget");

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
}
export interface WidgetCard {
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
    agents(session?: string): Promise<AgentsTree>;
    events?(ids: string[]): WidgetActivityEvent[];
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
let cachedAgents: { at: number; promise: Promise<AgentsTree> } | undefined;
export function widgetAgents(): Promise<AgentsTree> {
    if (!cachedAgents || Date.now() - cachedAgents.at > 15_000) {
        const promise = hubAgents({ hours: 168, limit: 150 });
        cachedAgents = { at: Date.now(), promise };
        promise.catch((error) => {
            if (cachedAgents?.promise === promise) {
                cachedAgents = undefined;
            }
            logger.debug({ error }, "Widget roster cache could not refresh");
        });
    }
    return cachedAgents.promise;
}

const resultCache = new Map<string, { mtime: number; text: string }>();
async function widgetResult(node: AgentNode): Promise<string> {
    if (!node.filePath || !existsSync(node.filePath)) {
        return "";
    }
    const stat = statSync(node.filePath);
    if (stat.size > 8 * 1024 * 1024) {
        return "This transcript is large. Open Conversation or Hub to read the result.";
    }
    const cached = resultCache.get(node.filePath);
    if (cached?.mtime === stat.mtimeMs) {
        return cached.text;
    }
    const resolved = await resolveTranscript(node.filePath, {}, node.harness);
    const envelope = await transcriptEnvelope(resolved, { limit: 20 });
    const text =
        envelope.turns.findLast((turn) => turn.role === "assistant" && turn.text.trim())?.text.slice(0, 32_000) ?? "";
    if (resultCache.size >= 100) {
        resultCache.clear();
    }
    resultCache.set(node.filePath, { mtime: stat.mtimeMs, text });
    return text;
}
export const realWidgetSources: WidgetSources = {
    sessions: (refresh) =>
        listAgentSessionRows({ hours: 168, withUsage: false, refresh, maxDiscoveryAgeMs: 15_000, failClosed: true }),
    decisions: () => readDecisions(decisionFiles().file),
    forms: (sessionHint) => {
        const db = openPendingStore();
        try {
            return listForms(db, {
                ...(sessionHint ? { sessionHint } : { status: "pending" }),
                limit: sessionHint ? 80 : 250,
            });
        } finally {
            db.close();
        }
    },
    answers: (sessionId) => {
        const db = openReadModel(toolDataDir("question", "qa.db"));
        try {
            return queryEntries(db, { sessionId, limit: sessionId ? 80 : 100 });
        } finally {
            db.close();
        }
    },
    agents: () => widgetAgents(),
    events: (ids) => readWidgetDecisionEvents({ ids }),
};

function provider(value: string | null | undefined): WidgetTarget["provider"] {
    if (value === "claude" || value === "claude-code") {
        return "claude";
    }
    return value === "codex" || value === "grok" ? value : "unknown";
}
function targetOf(
    row: { provider?: string | null; sessionId?: string | null; sourceHome?: string; cwd?: string | null },
    fallback: string
): WidgetTarget {
    return {
        hostId: "local",
        provider: provider(row.provider),
        sessionId: row.sessionId || fallback,
        sourceHome: row.sourceHome ?? "",
        cwd: row.cwd ?? "",
    };
}
function cleanVisibleContext(text: string): string {
    return text.replace(/<from(?:Image|Video)>[\s\S]*?<\/from(?:Image|Video)>/g, "").trim();
}
function flattenAgents(nodes: AgentNode[]): AgentNode[] {
    return nodes.flatMap((node) => [node, ...flattenAgents(node.children)]);
}

export function readWidgetChanges({
    target,
    path = sessionChangesPath(target.sessionId),
}: {
    target: WidgetTarget;
    path?: string;
}): {
    available: boolean;
    files: { path: string; at: string; source: string }[];
} {
    if (!existsSync(path)) {
        return { available: false, files: [] };
    }
    if (statSync(path).size > 16 * 1024 * 1024) {
        throw new Error("Change receipt is too large for the widget; open it in Hub");
    }

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
}: {
    root?: string;
    selectedKey?: string;
    refresh?: boolean;
    sources?: WidgetSources;
}) {
    const state = await readWidgetState(root);
    selectedKey ??= state.selectedKey ?? undefined;
    const errors: string[] = [];
    async function read<T>(name: string, fn: () => T | Promise<T>, fallback: T): Promise<T> {
        try {
            return await prof.measureAsync(name, async () => fn());
        } catch (error) {
            logger.warn({ error, name }, "Widget source unavailable");
            errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            return fallback;
        }
    }
    const [rows, decisions, waitingForms, agents, answerRoster] = await Promise.all([
        read("sessions", () => sources.sessions(refresh), []),
        read("decisions", sources.decisions, []),
        read("questions", () => sources.forms(), []),
        read("agents", () => sources.agents(), { generatedAt: "", parents: [], orphans: [] }),
        read("answer sessions", () => sources.answers(), []),
    ]);
    const sessions = new Map<string, WidgetSession>();
    const addSession = (target: WidgetTarget, title: string, project: string, activityAt: number): WidgetSession => {
        const key = widgetSessionKey(target);
        const existing = sessions.get(key);
        if (existing) {
            return existing;
        }
        const hiddenByFilter =
            (state.preferences.projects.length > 0 && !state.preferences.projects.includes(target.cwd)) ||
            (state.preferences.sessions.length > 0 && !state.preferences.sessions.includes(key));
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
        }
    }
    const findSession = (id: string, hint?: string | null) => {
        const matches = [...sessions.values()].filter(
            (entry) => entry.target.sessionId === id && (!hint || entry.target.provider === provider(hint))
        );
        return matches.length === 1 ? matches[0] : undefined;
    };
    const addWorker = (node: AgentNode, parent?: WidgetSession) => {
        const target = targetOf(
            {
                provider: node.harness,
                sessionId: node.id,
                cwd: parent?.target.cwd,
                sourceHome: parent?.target.sourceHome,
            },
            node.id
        );
        const session = addSession(
            target,
            node.name ?? node.description ?? node.id,
            parent?.project ?? "Agent",
            Date.parse(node.lastAt)
        );
        session.status = node.status === "running" ? "working" : node.status === "completed" ? "finished" : "recent";
        session.agentId = node.id;
        session.parentSessionId = parent?.target.sessionId;
        session.transcriptPath = node.filePath ?? undefined;
        return session;
    };
    for (const parent of agents.parents) {
        const session =
            findSession(parent.sessionId, parent.provider) ??
            addSession(
                targetOf(parent, parent.sessionId),
                parent.title ?? parent.sessionId,
                parent.project ?? parent.cwd,
                Date.parse(parent.lastAt)
            );
        session.transcriptPath ??= parent.filePath;
        const nodes = flattenAgents(parent.children);
        for (const node of nodes) {
            addWorker(node, session);
        }
        if (nodes.some((node) => node.status === "running")) {
            session.status = "working";
        }
    }
    for (const node of flattenAgents(agents.orphans)) {
        addWorker(node);
    }
    for (const decision of decisions) {
        const session =
            findSession(decision.sessionId, decision.provider) ??
            addSession(
                targetOf({ ...decision, sessionId: decision.sessionId }, decision.id),
                decision.sessionTitle ?? decision.sessionId,
                decision.project ?? decision.cwd ?? "",
                Date.parse(decision.updatedTs)
            );
        if (["open", "drafted"].includes(decision.state)) {
            session.status = "waiting";
        }
    }
    for (const form of waitingForms) {
        const session = form.sessionHint ? findSession(form.sessionHint) : undefined;
        const current =
            session ??
            addSession(
                targetOf({ sessionId: form.sessionHint, cwd: form.cwd }, form.id),
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
    const selected = selectedKey ? sessions.get(selectedKey) : undefined;
    const persistedTarget = selectedKey ? parseWidgetSessionKey(selectedKey) : undefined;
    const selectedId = selected?.target.sessionId ?? persistedTarget?.sessionId;
    const [answers, forms] = await Promise.all([
        selectedId ? read("answers", () => sources.answers(selectedId), []) : Promise.resolve(answerRoster),
        selectedId ? read("question timeline", () => sources.forms(selectedId), []) : Promise.resolve(waitingForms),
    ]);
    for (const form of forms) {
        const id = form.sessionHint || form.id;
        if (!findSession(id)) {
            const identity = persistedTarget?.sessionId === id ? persistedTarget : targetOf({ sessionId: id }, form.id);
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
        cards.push({
            id: `answer:${row.id}`,
            kind: "answer",
            sessionKey: session.key,
            sourceId: row.id,
            at: row.ts,
            title: row.question,
            body: cleanVisibleContext(row.answerMd),
            status: "answered",
            choices: [],
            attachments: row.attachments ?? [],
            refs: row.refs,
            read: row.readAt !== null,
        });
    }
    for (const row of decisions) {
        const session = findSession(row.sessionId, row.provider);
        if (!session || (selectedKey && session.key !== selectedKey)) {
            continue;
        }
        cards.push({
            id: `decision:${row.id}`,
            kind: kindOf(row),
            sessionKey: session.key,
            sourceId: row.id,
            at: Date.parse(row.updatedTs),
            title: row.title ?? row.prompt,
            body: cleanVisibleContext(
                [row.context, row.reasoning, row.proposal, row.answer, row.notes].filter(Boolean).join("\n\n")
            ),
            status: row.delivery?.uncertain ? "delivery unknown" : row.state,
            number: row.number,
            revision: row.revision ?? 1,
            choices: row.options.map((title, index) => ({
                id: String.fromCharCode(97 + index),
                title,
                recommended: row.recommended === String.fromCharCode(97 + index),
            })),
            attachments: [],
            refs: (row.refs ?? []).map((ref) => ({ type: "file", value: ref.path })),
            read: true,
        });
    }
    for (const form of forms) {
        const session =
            (form.sessionHint ? findSession(form.sessionHint) : undefined) ??
            [...sessions.values()].find((entry) => entry.target.sessionId === form.id);
        if (!session || (selectedKey && session.key !== selectedKey)) {
            continue;
        }
        cards.push({
            id: `form:${form.id}`,
            kind: "form",
            sessionKey: session.key,
            sourceId: form.id,
            at: form.resolvedAt ?? form.createdAt,
            title: form.items[0]?.promptMarkdown ?? "Question",
            body:
                form.status === "answered"
                    ? cleanVisibleContext(renderFormAnswer(form, form.answers ?? {}))
                    : form.items.length > 1
                      ? `${String(form.items.length)} questions`
                      : "",
            status: form.status,
            choices: [],
            formItems: form.items,
            formAnswers: form.answers,
            attachments: [],
            refs: [],
            read: form.status !== "pending",
            entryId: form.entryId,
        });
    }
    for (const node of [
        ...agents.parents.flatMap((parent) => flattenAgents(parent.children)),
        ...flattenAgents(agents.orphans),
    ]) {
        const session = findSession(node.id, node.harness);
        if (!session || node.status === "running" || (selectedKey && session.key !== selectedKey)) {
            continue;
        }
        const result = selectedKey ? await read("agent result", () => widgetResult(node), "") : "";
        cards.push({
            id: `result:${node.harness}:${node.id}`,
            kind: "result",
            sessionKey: session.key,
            sourceId: node.id,
            at: Date.parse(node.lastAt),
            title: node.name ?? node.description ?? node.id,
            body:
                result ||
                `Task context: ${node.spawnPromptPreview ?? node.description ?? "Open the conversation to read the agent's result."}`,
            status: node.status,
            choices: [],
            attachments: [],
            refs: node.filePath ? [{ type: "file", value: node.filePath }] : [],
            read: false,
        });
    }
    const manifests: Record<string, unknown> = {};
    for (const asset of Object.values(state.assets)) {
        if (asset.type === "video" && asset.status === "ready") {
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
        activity,
        sessions: [...sessions.values()].sort(
            (a, b) => Number(b.status === "waiting") - Number(a.status === "waiting") || b.activityAt - a.activityAt
        ),
        cards: cards
            .filter((card) => !selectedKey || card.sessionKey === selectedKey)
            .sort((a, b) => a.at - b.at)
            .slice(-100),
        manifests,
        changes,
        errors,
        selectedKey: selectedKey ?? null,
    };
}
