import { randomUUID } from "node:crypto";
import logger from "@app/logger";
import { type AgentRuntimeContext, getAgentRuntimeContext } from "@app/utils/agent-runtime";
import { loadConfig, type QuestionConfig } from "./config";
import { appendEntry } from "./log-store";
import { runFanOut } from "./sinks/registry";
import "./sinks/obsidian";
import "./sinks/sound";
import "./sinks/notification";
import type { QaEntry, RecordInput, RecordResult } from "./types";

const log = logger.child({ component: "question:record" });

export interface RecordDeps {
    logBase?: string;
    env?: NodeJS.ProcessEnv;
    ctx?: Partial<AgentRuntimeContext>;
    /** Override resolved config (tests inject this to avoid touching the real vault). */
    config?: Partial<QuestionConfig>;
}

export async function recordAnswer(input: RecordInput, deps: RecordDeps = {}): Promise<RecordResult> {
    const question = input.question?.trim();
    const answer = input.answer?.trim();
    if (!question) {
        throw new Error("recordAnswer: question is empty");
    }

    if (!answer) {
        throw new Error("recordAnswer: answer is empty");
    }

    const ctx = getAgentRuntimeContext(
        {
            ...deps.ctx,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.project ? { project: input.project } : {}),
        },
        deps.env ?? process.env
    );

    const entry: QaEntry = {
        id: randomUUID(),
        ts: Date.now(),
        sessionId: ctx.sessionId ?? "unknown",
        sessionTitle: ctx.sessionTitle,
        project: ctx.project,
        repoRoot: ctx.repoRoot,
        cwd: ctx.cwd,
        branch: ctx.branch,
        commitSha: ctx.commitSha,
        isWorktree: ctx.isWorktree,
        worktreePath: ctx.worktreePath,
        aiAgent: ctx.aiAgent,
        agentLabel: input.agentLabel ?? null,
        tag: input.tag,
        question,
        answerMd: answer,
        refs: input.refs ?? [],
        source: input.source,
        turnUuid: null,
    };

    appendEntry(entry, deps.logBase);
    log.info({ id: entry.id, project: entry.project, tag: entry.tag, source: entry.source }, "qa recorded");
    const sinks = await runFanOut(entry, { ...loadConfig(), ...deps.config });
    return { id: entry.id, sinks };
}
