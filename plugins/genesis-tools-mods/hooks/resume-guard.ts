// The resume guard (`mods.resumeGuard`, off by default). An agent's prompt cache lives 5 minutes after its last call,
// so a SendMessage to an agent of this session that is idle for longer makes it write its whole context again at the
// cache-write price, and carry it on every later call. The guard refuses such a send once, with the cost and the two
// ways on; the same send again goes through, until the agent has run again. Over 75 days on one Mac, 687 of 764 such
// resumes missed the cache (README.md, "The resume guard").
//
// An agent that finished is no longer in the engine's list, and a message to it is the common resume: it is found by
// its transcript in this session's folder (seen live on 2026-11-11: the first send to a finished agent was skipped
// as "not-an-agent").
//
// The idle time comes from the session's agent clock (`agent-clock.ts`), or from the mtime of the agent's transcript
// when the clock has not seen it (a reload of the mods). The context is the agent's last model call, input plus cache
// read plus cache write plus output, as its `turn.step` stop chunk reported it, or the last usage in its transcript's end. When either
// stays unknown the send goes through: an unknown size is no reason to block.
import type { AgentInfo, ModelUsage, ToolCallInput } from "claude-code";
import { agentActiveAt, agentClockTime } from "./agent-clock";
import { sessionDirOf } from "./agents-band";
import { METRICS_SPOOL_VERSION, RESUME_DEFINITION, type SpoolEvent, spoolEvents } from "./metrics";
import {
    appendJsonl,
    type Feature,
    type Host,
    isRecord,
    jsonOf,
    logMod,
    type ModsSettings,
    settingsOf,
} from "./shared";

export type ResumeSettings = ModsSettings["resumeGuard"];

/** Each agent's context at its last model call, from `turn.step`'s usage, by agent id. */
const contexts = new Map<string, number>();
/** The refusals the agent has not yet answered by running: when, and the size the refusal named, by agent id. */
const refusals = new Map<string, { at: number; tokens: number; idleMs: number }>();

/** A loop in these states makes its calls now, so its cache is warm. */
const RUNNING = new Set(["pending", "running"]);
/** How much of a transcript's end is searched for the last usage; the engine cuts a run's output at 4 MiB. */
const TAIL_BYTES = 1_048_576;
/** What a fresh general-purpose agent's first call held, measured over 75 days (README.md). */
const FRESH_START_K = 66;

/** The tokens a call's context held: what it read uncached, read from the cache, wrote to it, and produced. */
export function contextTokens(usage: ModelUsage): number {
    return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens;
}

/** SendMessage's `to` without the ` [ref]` a listing may append to a name; undefined when it is no text. */
export function recipientOf(to: unknown): string | undefined {
    if (typeof to !== "string") {
        return undefined;
    }

    const bare = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();

    return bare || undefined;
}

/** The agents of the session `to` names: by name, else by id, else a teammate by the name part of its address. */
export function agentsNamed(agents: readonly AgentInfo[], to: string): AgentInfo[] {
    const byName = agents.filter((agent) => agent.name === to);

    if (byName.length > 0) {
        return byName;
    }

    const byId = agents.filter((agent) => agent.id === to);

    if (byId.length > 0) {
        return byId;
    }

    return agents.filter((agent) => agent.teammateId?.split("@")[0] === to);
}

const USAGE_FIELDS = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"];

function countOf(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The context of the last model call in a transcript's end, or undefined when that end holds none. */
export function lastContextOf(tail: string): number | undefined {
    const lines = tail.split("\n");

    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index] ?? "";

        if (!line.includes('"usage"')) {
            continue;
        }

        // The first line of a byte-cut end is half a row, which reads as none.
        const row = jsonOf(line);
        const message = isRecord(row) && isRecord(row.message) ? row.message : undefined;
        const usage = message && isRecord(message.usage) ? message.usage : undefined;
        const tokens = usage ? USAGE_FIELDS.reduce((sum, field) => sum + countOf(usage[field]), 0) : 0;

        if (tokens > 0) {
            return tokens;
        }
    }

    return undefined;
}

/** The agent a message goes to: one the engine lists, or a finished one known by its transcript. */
export type ResumeTarget = Pick<AgentInfo, "id" | "status" | "type"> & { name?: string; teammateId?: string };

export type ResumeOutcome = "refused" | "resent" | "passed-warm" | "passed-small";

/** What the guard knows of the agent a message goes to. */
export interface ResumeFacts {
    status: string;
    isTeammate: boolean;
    idleMs: number | undefined;
    tokens: number | undefined;
    /** A refusal for this agent that it has not answered by running since. */
    isRefused: boolean;
}

/** Why the guard decided as it did; `idle-unknown` and `size-unknown` ask the transcript before they stand. */
export type ResumeReason =
    | "teammates-off"
    | "running"
    | "sent-again"
    | "idle-unknown"
    | "warm"
    | "size-unknown"
    | "small"
    | "cold-and-large";

export interface ResumeDecision {
    refuse: boolean;
    reason: ResumeReason;
    /** The metric's outcome; undefined for a skip the metric does not count. */
    outcome: ResumeOutcome | undefined;
}

/** Whether a message to an agent with these facts is refused. Unknown facts never refuse. */
export function decideResume(settings: ResumeSettings, facts: ResumeFacts): ResumeDecision {
    const pass = (reason: ResumeReason, outcome: ResumeOutcome | undefined): ResumeDecision => ({
        refuse: false,
        reason,
        outcome,
    });

    if (facts.isTeammate && !settings.teammates) {
        return pass("teammates-off", undefined);
    }

    if (RUNNING.has(facts.status)) {
        return pass("running", "passed-warm");
    }

    if (facts.isRefused) {
        return pass("sent-again", "resent");
    }

    if (facts.idleMs === undefined) {
        return pass("idle-unknown", undefined);
    }

    if (facts.idleMs < settings.idleSeconds * 1000) {
        return pass("warm", "passed-warm");
    }

    if (facts.tokens === undefined) {
        return pass("size-unknown", undefined);
    }

    if (facts.tokens < settings.minTokens) {
        return pass("small", "passed-small");
    }

    return { refuse: true, reason: "cold-and-large", outcome: "refused" };
}

/** The `idleSeconds` dim: `<5m`, `5-15m`, `15-60m` or `60m+`. */
export function idleBucket(idleMs: number): string {
    const minutes = idleMs / 60_000;

    if (minutes < 5) {
        return "<5m";
    }

    if (minutes < 15) {
        return "5-15m";
    }

    return minutes < 60 ? "15-60m" : "60m+";
}

/** The text the model reads as the refused call's error. No price: the plugin holds no price table. */
export function refusalText({
    name,
    idleMs,
    tokens,
    settings,
}: {
    name: string;
    idleMs: number;
    tokens: number;
    settings: ResumeSettings;
}): string {
    const seconds = Math.floor(idleMs / 1000);
    const k = `${Math.round(tokens / 1000)}k`;

    return [
        `Not sent (resume guard, once): ${name} is idle for ${Math.floor(seconds / 60)} min ${seconds % 60} s and holds about ${k} tokens of context. An agent's prompt cache lives 5 minutes, so this message makes it write all ${k} tokens again (cache-write price), then carry them on every later call. A fresh agent starts at about ${FRESH_START_K}k tokens.`,
        `- If the follow-up needs most of what ${name} already knows, send the same message again: it goes through.`,
        "- If it needs less than about half of it, start a new agent and put what it needs in the brief (files, findings, commit SHAs).",
        `Thresholds: mods.resumeGuard.idleSeconds=${settings.idleSeconds}, mods.resumeGuard.minTokens=${settings.minTokens}.`,
    ].join("\n");
}

/** The agent's transcript: `subagents/agent-<id>.jsonl`, or a workflow agent's one folder further down. */
async function transcriptOf(host: Host, agentId: string): Promise<string | undefined> {
    const dir = await sessionDirOf(host);

    if (!dir) {
        return undefined;
    }

    const direct = `${dir}/subagents/agent-${agentId}.jsonl`;

    if (await host.exists(direct).catch(() => false)) {
        return direct;
    }

    const runs = (await host.list(`${dir}/subagents/workflows`).catch(() => [])).filter((run) => run.kind === "dir");
    const paths = runs.map((run) => `${dir}/subagents/workflows/${run.name}/agent-${agentId}.jsonl`);
    const held = await Promise.all(paths.map((path) => host.exists(path).catch(() => false)));

    return paths.find((_, index) => held[index]);
}

/** An agent id as Claude Code makes them; a session name or a sentence is none. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;

/** A finished agent of this session the engine no longer lists, by the transcript its id names; else undefined. */
async function finishedAgent(host: Host, id: string): Promise<ResumeTarget | undefined> {
    if (!AGENT_ID.test(id)) {
        return undefined;
    }

    const path = await transcriptOf(host, id);

    if (!path) {
        return undefined;
    }

    const meta = jsonOf(await host.read(path.replace(/\.jsonl$/, ".meta.json")).catch(() => undefined));
    const type = isRecord(meta) && typeof meta.agentType === "string" ? meta.agentType : "unknown";
    const team = isRecord(meta) && typeof meta.teamName === "string" ? meta.teamName : undefined;

    return { id, status: "completed", type, ...(team ? { teammateId: `${id}@${team}` } : {}) };
}

/** What the agent's transcript says of its last activity and its last call's context, for the facts not known. */
async function readTranscript(
    host: Host,
    agentId: string,
    want: { idle: boolean; tokens: boolean }
): Promise<{ path: string | undefined; mtimeMs?: number; tokens?: number; tail?: string }> {
    const path = await transcriptOf(host, agentId);

    if (!path) {
        return { path };
    }

    const stat = want.idle ? await host.stat(path).catch(() => undefined) : undefined;
    const done = want.tokens
        ? await host.run(["tail", "-c", String(TAIL_BYTES), path], { timeoutMs: 5_000 }).catch(() => undefined)
        : undefined;
    const tail =
        done === undefined ? undefined : done.exitCode !== 0 ? "failed" : done.isStdoutTruncated ? "cut" : "read";
    const tokens = tail === "read" && done ? lastContextOf(done.stdout) : undefined;

    return { path, mtimeMs: stat?.mtimeMs, tokens, tail };
}

/** One `agent-context / agent.resume` event in the `tools metrics` spool; a failure never reaches the call. */
async function report(
    host: Host,
    facts: { agent: ResumeTarget; outcome: ResumeOutcome; tokens: number; idleMs: number; at: number }
): Promise<void> {
    const home = (await host.env("GENESIS_TOOLS_HOME")) ?? (await host.env("HOME"));

    if (!home) {
        return;
    }

    const event: SpoolEvent = {
        v: METRICS_SPOOL_VERSION,
        project: RESUME_DEFINITION.define.project,
        metric: RESUME_DEFINITION.define.metric,
        at: facts.at,
        value: facts.tokens,
        dims: {
            session: await host.sessionId(),
            agent: facts.agent.id,
            agentType: facts.agent.type,
            kind: facts.agent.teammateId === undefined ? "subagent" : "teammate",
            idleSeconds: idleBucket(facts.idleMs),
            outcome: facts.outcome,
        },
    };

    await spoolEvents({
        append: (path, record) => appendJsonl(host, path, record),
        home,
        definition: RESUME_DEFINITION,
        events: [event],
        at: facts.at,
    });
}

/**
 * The guard on a tool call: the refusal text for a SendMessage that would resume a cold, large agent the first time,
 * else undefined. Any other tool, and every call while the mod is off, costs one test and at most one cached read.
 */
export async function guardResume(host: Host, e: ToolCallInput): Promise<string | undefined> {
    if (e.tool !== "SendMessage") {
        return undefined;
    }

    const settings = (await settingsOf(host)).resumeGuard;

    if (!settings.enabled) {
        return undefined;
    }

    const to = recipientOf(e.to);
    const log = (record: Record<string, unknown>) =>
        logMod(host, "resume-guard", { to: to ?? null, ...record }).catch(() => undefined);

    if (typeof e.message !== "string") {
        await log({ decision: "skipped", reason: e.message === undefined ? "subscription" : "structured" });
        return undefined;
    }

    const matches = to ? agentsNamed(await host.agents().catch(() => []), to) : [];
    const agent: ResumeTarget | undefined =
        matches.length === 1 ? matches[0] : matches.length === 0 && to ? await finishedAgent(host, to) : undefined;

    if (!agent) {
        const dir = await sessionDirOf(host).catch(() => undefined);
        const direct = dir && to ? `${dir}/subagents/agent-${to}.jsonl` : undefined;
        await log({
            decision: "skipped",
            reason: matches.length > 1 ? "ambiguous" : "not-an-agent",
            // Why a finished agent's transcript was not found, when the name looked like an agent id.
            looked: direct ?? null,
            found: direct ? await host.exists(direct).catch((error) => String(error)) : null,
        });
        return undefined;
    }

    const now = agentClockTime.now();
    const activeAt = agentActiveAt(agent.id);
    const held = refusals.get(agent.id);
    const isRefused = held !== undefined && (activeAt === undefined || activeAt <= held.at);

    if (held && !isRefused) {
        refusals.delete(agent.id);
    }

    let facts: ResumeFacts = {
        status: agent.status,
        isTeammate: agent.teammateId !== undefined,
        idleMs: activeAt === undefined ? undefined : now - activeAt,
        tokens: contexts.get(agent.id),
        isRefused,
    };
    let decision = decideResume(settings, facts);
    const sources: Record<string, unknown> = {
        idleFrom: facts.idleMs === undefined ? null : "clock",
        tokensFrom: facts.tokens === undefined ? null : "step",
    };

    if (decision.reason === "idle-unknown" || decision.reason === "size-unknown") {
        const read = await readTranscript(host, agent.id, {
            idle: facts.idleMs === undefined,
            tokens: facts.tokens === undefined,
        });
        facts = {
            ...facts,
            idleMs: facts.idleMs ?? (read.mtimeMs === undefined ? undefined : Math.max(0, now - read.mtimeMs)),
            tokens: facts.tokens ?? read.tokens,
        };
        sources.idleFrom ??= read.mtimeMs === undefined ? null : "transcript-mtime";
        sources.tokensFrom ??= read.tokens === undefined ? null : "transcript";
        sources.transcript = read.path ?? null;
        sources.tail = read.tail ?? null;
        decision = decideResume(settings, facts);
    }

    const tokens = facts.tokens ?? held?.tokens;
    // A send after a refusal passes before its idle time is asked for: it is the refusal's, plus the time since.
    const idleMs =
        facts.idleMs ?? (isRefused && held ? held.idleMs + (now - held.at) : RUNNING.has(agent.status) ? 0 : undefined);
    await log({
        decision: decision.refuse ? "refused" : decision.outcome === "resent" ? "passed-after-refusal" : "skipped",
        reason: decision.reason,
        agent: agent.id,
        name: agent.name ?? null,
        status: agent.status,
        kind: facts.isTeammate ? "teammate" : "subagent",
        idleSeconds: idleMs === undefined ? null : Math.round(idleMs / 1000),
        tokens: tokens ?? null,
        ...sources,
    });

    if (decision.outcome !== undefined && tokens !== undefined && idleMs !== undefined) {
        await report(host, { agent, outcome: decision.outcome, tokens, idleMs, at: now }).catch(() => undefined);
    }

    if (!decision.refuse || facts.tokens === undefined || facts.idleMs === undefined) {
        return undefined;
    }

    refusals.set(agent.id, { at: now, tokens: facts.tokens, idleMs: facts.idleMs });

    return refusalText({ name: agent.name ?? to ?? agent.id, idleMs: facts.idleMs, tokens: facts.tokens, settings });
}

export const resumeGuard: Feature = {
    guardTool: guardResume,
    afterStep(_host, e, usage) {
        if (usage) {
            contexts.set(e.agentId, contextTokens(usage));
        }
    },
};

/** A test starts a different session. */
export function forgetResumeGuard(): void {
    contexts.clear();
    refusals.clear();
}
