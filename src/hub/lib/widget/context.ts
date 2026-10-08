import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { readDecisions } from "@app/question/lib/decisions/store";
import { getForm } from "@app/question/lib/pending/store";
import { getStoredEntryById } from "@app/question/lib/read-model";
import type { TranscriptAnchor } from "@genesiscz/utils/agent/source-anchor";
import { type TranscriptAround, transcriptAround } from "@genesiscz/utils/ai/transcripts/around";
import { resolveTranscript, type TranscriptRoots } from "@genesiscz/utils/ai/transcripts/resolve";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { WidgetCard, WidgetSources } from "./snapshot";
import { parseWidgetSessionKey } from "./types";

const prof = profiler.scope("widget");
export interface WidgetReceiptContext {
    id: string;
    sourceContext?: WidgetCard["sourceContext"];
    transcriptAnchor: TranscriptAnchor;
    transcript?: TranscriptAround;
    error?: string;
}

function readStoredReceipt<T>(read: (db: Database) => T | null): T | null {
    const dbPath = toolDataDir("question", "qa.db");
    if (!existsSync(dbPath)) {
        return null;
    }
    logger.debug({ dbPath }, "Opening stored receipt database read-only");
    const db = new Database(dbPath, { readonly: true, create: false });
    try {
        return read(db);
    } finally {
        db.close();
    }
}

function sourceStamp(source: NonNullable<WidgetCard["sourceContext"]>): NonNullable<WidgetCard["sourceContext"]> {
    const {
        sessionId,
        agent,
        agentLabel,
        aiAgent,
        project,
        cwd,
        repoRoot,
        branch,
        commitSha,
        isWorktree,
        worktreePath,
    } = source;
    return {
        sessionId,
        agent,
        agentLabel,
        aiAgent,
        project,
        cwd,
        repoRoot,
        branch,
        commitSha,
        isWorktree,
        worktreePath,
    };
}

/** Reads the stored receipt in its exact provider/session scope; it does not refresh the Widget roster. */
export async function readWidgetReceiptContext({
    key,
    id,
    before = 2,
    after = 2,
    signal,
    sources,
}: {
    key: string;
    id: string;
    root?: string;
    before?: number;
    after?: number;
    signal?: AbortSignal;
    sources?: Pick<WidgetSources, "answers" | "decisions" | "forms">;
}): Promise<WidgetReceiptContext> {
    for (const count of [before, after]) {
        if (!Number.isInteger(count) || count < 0 || count > 10) {
            throw new Error("Context before/after counts must be integers between 0 and 10");
        }
    }
    const target = parseWidgetSessionKey(key);
    if (!target) {
        throw new Error("Invalid Widget session identity");
    }
    signal?.throwIfAborted();
    const sourceId = id.slice(id.indexOf(":") + 1);
    let sourceContext: WidgetCard["sourceContext"];
    let anchor: TranscriptAnchor | undefined;
    let receivedAt = 0;
    let found = false;
    if (id.startsWith("answer:")) {
        const row = sources
            ? sources.answers(target.sessionId).find((entry) => entry.id === sourceId)
            : readStoredReceipt((db) => getStoredEntryById(db, sourceId));
        const provider = row?.agent === "claude-code" ? "claude" : row?.agent;
        if (row && row.sessionId === target.sessionId && provider === target.provider) {
            found = true;
            sourceContext = { ...row, agent: row.agent };
            anchor = row.transcriptAnchor;
            receivedAt = row.ts;
        }
    } else if (id.startsWith("decision:")) {
        const row = (sources ? sources.decisions() : readDecisions(decisionFiles().file)).find(
            (entry) => entry.id === sourceId
        );
        const provider = row?.provider === "claude-code" ? "claude" : (row?.provider ?? "unknown");
        if (row && row.sessionId === target.sessionId && provider === target.provider) {
            found = true;
            sourceContext = { ...row, agent: row.provider };
            anchor = row.transcriptAnchor;
            receivedAt = Date.parse(row.createdTs ?? row.updatedTs);
        }
    } else if (id.startsWith("form:")) {
        const row = sources
            ? sources.forms(target.sessionId).find((entry) => entry.id === sourceId)
            : readStoredReceipt((db) => getForm(db, sourceId));
        const storedProvider =
            row?.poster?.agent && row.poster.agent !== "unknown"
                ? row.poster.agent
                : row?.transcriptAnchor && row.transcriptAnchor.kind !== "unanchored"
                  ? row.transcriptAnchor.provider
                  : undefined;
        const provider = storedProvider === "claude-code" ? "claude" : storedProvider;
        if (row && (row.sessionHint ?? row.id) === target.sessionId && (provider ?? "unknown") === target.provider) {
            found = true;
            sourceContext = row.poster ? { ...row.poster, sessionId: target.sessionId } : undefined;
            anchor = row.transcriptAnchor;
            receivedAt = row.createdAt;
        }
    }
    if (!found) {
        throw new Error("The stored receipt was not found in this provider/session");
    }
    anchor ??=
        target.provider === "unknown"
            ? { kind: "unanchored", receivedAt }
            : { kind: "receipt-time", provider: target.provider, sessionId: target.sessionId, receivedAt };
    const result: WidgetReceiptContext = {
        id,
        sourceContext: sourceContext ? sourceStamp(sourceContext) : undefined,
        transcriptAnchor: anchor,
    };
    if (anchor.kind === "unanchored") {
        result.error = "This receipt has no source session. Its stored source details remain available.";
        return result;
    }
    if (anchor.provider !== target.provider || anchor.sessionId !== target.sessionId) {
        throw new Error("The stored receipt anchor belongs to a different provider/session");
    }
    const roots: TranscriptRoots = target.sourceHome
        ? target.provider === "claude"
            ? {
                  claudeProjects: join(target.sourceHome, "projects"),
                  claudeProjectsAll: [join(target.sourceHome, "projects")],
              }
            : target.provider === "codex"
              ? { codexHome: target.sourceHome }
              : { grokHome: target.sourceHome }
        : {};
    try {
        const resolved = await resolveTranscript(target.sessionId, roots, anchor.provider);
        signal?.throwIfAborted();
        result.transcript = prof.measure("receipt-context", () =>
            transcriptAround({ resolved, anchor, before, after, signal })
        );
    } catch (error) {
        signal?.throwIfAborted();
        result.error = error instanceof Error ? error.message : String(error);
        logger.debug({ error, id, provider: target.provider }, "Receipt transcript unavailable");
    }
    return result;
}
