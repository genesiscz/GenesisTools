import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { readCachedHistoryTitle } from "@genesiscz/utils/agent-sessions/cached-title";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import { harnessDriver, harnessOfRuntimeAgent, harnessPluginId } from "@genesiscz/utils/ai/providers/harness-index";
import { logger } from "@genesiscz/utils/logger";
import { runtimeAgentOfCommand } from "@genesiscz/utils/process/classify";
import { resolveAncestorCwd } from "@genesiscz/utils/process/cwd";
import { ancestry, readExecutablePath } from "@genesiscz/utils/process/processes";
import { profiler } from "@genesiscz/utils/profile";
import { enrichIdentity } from "./enrichers";
import { type GivenGitFacts, gitCommonRoot, readGitFacts } from "./git";
import { CALLER_SOURCES } from "./sources";
import type {
    AgentIdentity,
    CallerAgent,
    CallerInput,
    CallerProcess,
    CallerReading,
    CallerSource,
    FactSource,
    IdentityFacet,
    IdentityField,
    WhoIsCallingOptions,
} from "./types";

export { hostLabel, resolveEnvHost } from "./env";
export { clearGitFactsCache, gitCommonRoot } from "./git";
export { callerSessionReadable, type PeerCaller, readPeerCaller } from "./peer";
export { CALLER_SOURCES } from "./sources";
export type * from "./types";

const prof = profiler.scope("agent-context");
const { log } = logger.scoped("agent-context");

const MAX_ANCESTRY_DEPTH = 20;
const MAX_COMMAND_CHARS = 240;

/**
 * Who is calling, from one input, through one precedence rule (`CALLER_SOURCES`). The env-only path (no facets) reads
 * the given environment and nothing else: no file, no process, no spawn. Each costly fact is filled only for its
 * facet. A remote caller (`origin: "remote"`) has no environment here, so none of this process's env, terminal or
 * account reaches it. `sources` replaces the precedence list in a test.
 */
export function whoIsCalling(
    input: CallerInput,
    options: WhoIsCallingOptions = {},
    sources: readonly CallerSource[] = CALLER_SOURCES
): AgentIdentity {
    return prof.measure("identity.whoIsCalling", () => compose(input, options, sources));
}

function readSafely(source: CallerSource, input: CallerInput): CallerReading | undefined {
    try {
        return source.read(input);
    } catch (error) {
        log.debug({ error, source: source.id }, "agent-context: a caller source failed; the next one answers");
        return undefined;
    }
}

function setFact<F extends IdentityField>(
    identity: AgentIdentity,
    field: F,
    value: AgentIdentity[F],
    source: FactSource
): void {
    identity[field] = value;
    identity.sources[field] = source;
}

/** The first reading that names an agent chooses the caller; with none, the first reading that says anything. */
function selectCaller(readings: { source: FactSource; reading: CallerReading }[]) {
    return readings.find(({ reading }) => reading.agent !== "unknown") ?? readings[0];
}

/** A later reading adds facts only when it describes the same caller: the same agent, and no other session. */
function sameCaller(chosen: CallerReading, other: CallerReading): boolean {
    if (other.agent !== chosen.agent) {
        return false;
    }

    return !chosen.sessionId || !other.sessionId || chosen.sessionId === other.sessionId;
}

function applyReadings(identity: AgentIdentity, readings: { source: FactSource; reading: CallerReading }[]): void {
    const chosen = selectCaller(readings);

    if (!chosen) {
        return;
    }

    for (const { source, reading } of readings) {
        if (reading !== chosen.reading && !sameCaller(chosen.reading, reading)) {
            log.debug({ source, agent: reading.agent }, "agent-context: source names another caller; not used");
            continue;
        }

        const added: string[] = [];

        for (const [field, value] of Object.entries(reading) as [IdentityField, AgentIdentity[IdentityField]][]) {
            const current = identity[field];

            // The chosen reading sets every fact it has; a later one only fills what is still empty.
            if (value === undefined || (reading !== chosen.reading && current !== undefined && current !== null)) {
                continue;
            }

            setFact(identity, field, value, source);
            added.push(field);
        }

        log.debug({ source, agent: reading.agent, fields: added }, "agent-context: source");
    }
}

/**
 * The directory the SESSION is in, which is not always ours. `process.cwd()` is fixed at spawn, and an MCP server
 * keeps its first directory after the session moves (EnterWorktree). The host process does chdir, so the nearest
 * ancestor with a different cwd is the live answer, accepted only when it shares our `.git`, so a terminal emulator
 * sitting in `~` can never be mistaken for the session.
 */
export function resolveSessionCwd(): string {
    return prof.measure("runtime.resolveSessionCwd", () => {
        const own = process.cwd();
        const candidate = resolveAncestorCwd({ ownCwd: own });

        if (!candidate) {
            return own;
        }

        const ownRepo = gitCommonRoot(own);

        if (!ownRepo || ownRepo !== gitCommonRoot(candidate)) {
            log.debug({ own, candidate }, "agent-runtime: ancestor cwd is a different repo, keeping process.cwd()");
            return own;
        }

        log.debug({ own, candidate }, "agent-runtime: adopting the host process cwd");
        return candidate;
    });
}

/**
 * The cwd: an override, then the fallback of a scope whose session is explicitly null (a blank one is none), then a
 * source's. A remote caller that none of them names has NO cwd: this process's cwd and its parents describe the
 * server, never the caller it serves, so neither they nor their git facts are stamped on it.
 */
function chooseCwd(
    identity: AgentIdentity,
    input: CallerInput,
    options: WhoIsCallingOptions,
    facets: Set<IdentityFacet>
) {
    const overrides = options.overrides ?? {};
    const scopedNull = input.origin === "remote" && input.caller !== undefined && input.caller.sessionId === null;
    const fallbackCwd = options.fallbackCwd?.trim() ? options.fallbackCwd : undefined;

    if (overrides.cwd !== undefined) {
        setFact(identity, "cwd", overrides.cwd, "override");
    } else if (fallbackCwd !== undefined && scopedNull) {
        setFact(identity, "cwd", fallbackCwd, "fallback-cwd");
    } else if (identity.cwd !== undefined || input.origin === "remote") {
        return;
    } else if (facets.has("cwd")) {
        setFact(identity, "cwd", resolveSessionCwd(), "session-cwd");
    } else {
        setFact(identity, "cwd", process.cwd(), "process-cwd");
    }
}

function readGit(identity: AgentIdentity, cwd: string, options: WhoIsCallingOptions): void {
    const overrides = options.overrides ?? {};
    const given: GivenGitFacts = {};
    const fields = [
        "project",
        "repoRoot",
        "isWorktree",
        "worktreePath",
        "branch",
        "commitSha",
        "commitMessage",
    ] as const;

    for (const field of fields) {
        if (Object.hasOwn(overrides, field)) {
            given[field] = true;
        }
    }

    const git = readGitFacts(cwd, given);

    for (const field of fields) {
        setFact(identity, field, git[field], "git");
    }
}

function applyOverrides(identity: AgentIdentity, options: WhoIsCallingOptions): void {
    for (const [field, value] of Object.entries(options.overrides ?? {}) as [
        IdentityField,
        AgentIdentity[IdentityField],
    ][]) {
        if (field !== "cwd") {
            setFact(identity, field, value, "override");
        }
    }
}

function readTitle(identity: AgentIdentity, given: ReadonlySet<IdentityField>): void {
    const harness = harnessOfRuntimeAgent(identity.agent);
    const sessionId = identity.sessionId;

    if (given.has("sessionTitle") || identity.sessionTitle || !harness || !sessionId) {
        return;
    }

    try {
        const meta = prof.measure("runtime.titleLookup", () =>
            readCachedHistoryTitle({ providerId: harnessPluginId(harness), sessionId })
        );
        setFact(identity, "sessionTitle", meta?.customTitle ?? meta?.summary ?? null, "history");
    } catch (error) {
        // History index is optional; logged so a missing or corrupt index is diagnosable.
        log.debug({ error, sessionId }, "agent-runtime: failed to backfill cached session title");
    }
}

/** The query of the transcript facet: one session of one caller, from that caller's own env. */
export interface CallerTranscriptLookup {
    agent: CallerAgent;
    sessionId: string | null;
    /** The caller's environment; a remote caller's is unknown, so `{}` (the default homes). */
    env: NodeJS.ProcessEnv;
    cwds: readonly string[];
    now?: Date;
    home?: string;
}

/**
 * The transcript of a caller's session through its harness's locator (`TranscriptLocator.callerTranscript`, in the
 * reader's `<harness>-locate.ts`): Claude by its project folder, Codex in the first `CODEX_HOME` entry and the last
 * seven days, Grok by its cwd folder. Null for a host with no harness (Copilot) and for no session.
 */
export function callerTranscriptOf(lookup: CallerTranscriptLookup): string | null {
    const harness = harnessOfRuntimeAgent(lookup.agent);
    const sessionId = lookup.sessionId;

    if (!harness || !sessionId) {
        return null;
    }

    return prof.measure("failures.transcriptOf", () =>
        harnessDriver(harness).parts.locate.callerTranscript({
            sessionId,
            env: lookup.env,
            cwds: lookup.cwds.filter((cwd) => cwd),
            home: lookup.home,
            now: lookup.now ?? new Date(),
        })
    );
}

/** The model a caller's session runs now, from its transcript, through its harness's model reader. */
export function callerModelOf(agent: CallerAgent, transcriptPath: string | null): string | null {
    const harness = harnessOfRuntimeAgent(agent);
    return transcriptPath && harness ? harnessHooks(harness).currentModel(transcriptPath) : null;
}

/**
 * The transcript and model facets. A given value (an override, null included) is the answer and nothing is read.
 * Both lookups are optional facts: a failure (an unreadable folder, a race) is logged and leaves that fact unset,
 * never a claim that the transcript does not exist, and every fact already resolved stands.
 */
function readTranscriptAndModel({
    identity,
    input,
    options,
    facets,
    given,
}: {
    identity: AgentIdentity;
    input: CallerInput;
    options: WhoIsCallingOptions;
    facets: Set<IdentityFacet>;
    given: ReadonlySet<IdentityField>;
}): void {
    const needModel = facets.has("model") && !given.has("model") && !identity.model;
    const needPath = facets.has("transcript") || needModel;

    if (needPath && !given.has("transcriptPath") && identity.transcriptPath === undefined) {
        try {
            const path = callerTranscriptOf({
                agent: identity.agent,
                sessionId: identity.sessionId,
                env: input.origin === "local" ? input.env : {},
                cwds: [identity.cwd ?? "", identity.repoRoot ?? ""],
                now: options.now,
                home: options.home,
            });
            setFact(identity, "transcriptPath", path, "transcript");
        } catch (error) {
            log.debug({ error, sessionId: identity.sessionId }, "agent-context: the transcript lookup failed");
            return;
        }
    }

    if (!needModel) {
        return;
    }

    try {
        setFact(identity, "model", callerModelOf(identity.agent, identity.transcriptPath ?? null), "transcript");
    } catch (error) {
        log.debug({ error, transcriptPath: identity.transcriptPath }, "agent-context: the model lookup failed");
    }
}

/**
 * The facts that belong to one session, not to the caller's place: when an override names another caller, the
 * named session's values describe nobody it is, so they go unless the override gave them too. The requested facets
 * then read them for the new session. `sourceMessage` keeps its own slot (set to undefined), as the runtime context
 * always had it.
 */
const SESSION_BOUND = [
    "sessionTitle",
    "model",
    "effort",
    "transcriptPath",
    "turnId",
    "subagentId",
    "toolUseId",
] as const;

function dropRetargetedFacts(
    identity: AgentIdentity,
    named: Pick<AgentIdentity, "agent" | "sessionId">,
    given: ReadonlySet<IdentityField>
): void {
    if (identity.agent === named.agent && identity.sessionId === named.sessionId) {
        return;
    }

    if (!given.has("sourceMessage")) {
        identity.sourceMessage = undefined;
        delete identity.sources.sourceMessage;
    }

    for (const field of SESSION_BOUND) {
        if (!given.has(field)) {
            delete identity[field];
            delete identity.sources[field];
        }
    }
}

function parentChain(pid: number): CallerProcess["ancestry"] {
    return ancestry(pid, MAX_ANCESTRY_DEPTH)
        .filter((entry) => entry.pid > 1 && entry.pid !== pid)
        .map((entry) => ({
            pid: entry.pid,
            command: (entry.command ?? readExecutablePath(entry.pid) ?? "").slice(0, MAX_COMMAND_CHARS),
        }));
}

function readProcess(identity: AgentIdentity, input: CallerInput, options: WhoIsCallingOptions): void {
    const pid = input.origin === "local" ? process.pid : identity.process?.pid;

    if (pid === undefined) {
        return;
    }

    try {
        const chain = prof.measure("identity.process", () => (options.processChain ?? parentChain)(pid));
        setFact(identity, "process", { pid, ancestry: chain }, "process");
    } catch (error) {
        log.debug({ error, pid }, "agent-context: could not read the caller's process ancestry");
    }
}

/**
 * Below every source, for the `process` facet of a LOCAL caller only: when no source named an agent, the nearest agent
 * process of the parent chain does (a shell an agent started with `env -i`, a command whose session variable was
 * cleared). It names no session. It runs before the enrichers, so that agent's harness account is read. A remote
 * caller's chain is not used: the gateway already judged the connection's owner, and a parent of it is no caller.
 */
function readAncestryAgent(identity: AgentIdentity): void {
    if (identity.agent !== "unknown" || !identity.process) {
        return;
    }

    for (const frame of identity.process.ancestry) {
        const agent = runtimeAgentOfCommand(frame.command);

        if (agent) {
            setFact(identity, "agent", agent, "process");
            setFact(identity, "isInAgent", true, "process");
            log.debug({ agent, pid: frame.pid }, "agent-context: the parent chain names the caller");
            return;
        }
    }
}

function compose(input: CallerInput, options: WhoIsCallingOptions, sources: readonly CallerSource[]): AgentIdentity {
    const facets = new Set(options.facets ?? []);
    const given = new Set(Object.keys(options.overrides ?? {}) as IdentityField[]);
    const identity: AgentIdentity = { agent: "unknown", sessionId: null, isInAgent: false, aiAgent: null, sources: {} };
    const readings = sources.flatMap((source) => {
        const reading = readSafely(source, input);
        return reading ? [{ source: source.id, reading }] : [];
    });

    applyReadings(identity, readings);

    // A request scope always carries its source message slot, set or not, as the runtime context always had it.
    if (input.origin === "remote" && input.caller && identity.sources.agent === "caller-scope") {
        identity.sourceMessage = input.caller.sourceMessage;
    }

    const named = { agent: identity.agent, sessionId: identity.sessionId };
    chooseCwd(identity, input, options, facets);

    if (facets.has("git") && identity.cwd !== undefined) {
        readGit(identity, identity.cwd, options);
    }

    applyOverrides(identity, options);
    dropRetargetedFacts(identity, named, given);

    if (facets.has("title")) {
        readTitle(identity, given);
    }

    readTranscriptAndModel({ identity, input, options, facets, given });

    if (facets.has("process")) {
        readProcess(identity, input, options);

        if (input.origin === "local") {
            readAncestryAgent(identity);
        }
    }

    if (input.origin === "local") {
        enrichIdentity(
            identity,
            { caller: { agent: identity.agent, sessionId: identity.sessionId }, env: input.env, facets },
            given
        );
    }

    return identity;
}

/**
 * The identity as today's `AgentRuntimeContext` (the git and cwd facets filled). A remote caller with no cwd keeps an
 * empty one (and an empty repo root), which every stamp drops, rather than this server's.
 */
export function toRuntimeContext(identity: AgentIdentity): AgentRuntimeContext {
    const cwd = identity.cwd ?? "";
    const context: AgentRuntimeContext = {
        agent: identity.agent,
        sessionId: identity.sessionId,
        isInAgent: identity.isInAgent,
        aiAgent: identity.aiAgent,
        sessionTitle: identity.sessionTitle ?? null,
        project: identity.project ?? "",
        repoRoot: identity.repoRoot ?? cwd,
        cwd,
        isWorktree: identity.isWorktree ?? false,
        worktreePath: identity.worktreePath ?? null,
        branch: identity.branch ?? null,
        commitSha: identity.commitSha ?? null,
        commitMessage: identity.commitMessage ?? null,
    };

    if (Object.hasOwn(identity, "sourceMessage")) {
        context.sourceMessage = identity.sourceMessage;
    }

    return context;
}
