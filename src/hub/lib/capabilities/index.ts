import type { PolicyClass } from "@app/dev-dashboard/contract/endpoint-table";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { TranscriptProvider } from "@genesiscz/utils/ai/transcripts/types";
import { hoursArg, limitArg } from "../../commands/agents-args";

/**
 * One hub capability: its input check, defaults, policy class and typed run, in one module that two adapters mount.
 * The hub door (`src/hub/server/doors`) keeps the CLI's argv grammar and prints the result as the CLI would; the
 * gateway (`src/dev-dashboard/server/routes/gateway.ts`) serves it over HTTP to the phone. Neither restates the
 * parse, the defaults or the error map. The commander keeps its own wider grammar (`procs --stop`, human renderers).
 */

/** Why a capability refused. A closed set: the door prints the message, the gateway maps the code to a status. */
export type CapabilityRefusalCode = "bad-input" | "not-found";

export class CapabilityRefusedError extends Error {
    constructor(
        readonly code: CapabilityRefusalCode,
        message: string
    ) {
        super(message);
        this.name = "CapabilityRefusedError";
    }
}

/**
 * The door rules as checked data. Each literal `false` is a type: a capability that is TCC-gated, interactive, spends
 * a credential (an OAuth refresh) or starts a long-lived child does not compile into this table. A write must be
 * idempotent (keyed or set, never appended), because a dropped connection replays it.
 */
export interface DoorRules {
    readonly tccGated: false;
    readonly interactive: false;
    readonly spendsCredential: false;
    readonly startsLongLivedChild: false;
    readonly writes: "none" | "idempotent";
}

const READ_ONLY: DoorRules = {
    tccGated: false,
    interactive: false,
    spendsCredential: false,
    startsLongLivedChild: false,
    writes: "none",
};

export interface HubCapability<I = unknown, O = unknown> {
    policy: PolicyClass;
    rules: DoorRules;
    /** Checks a loose input (an HTTP query, a parsed argv) and fills the defaults. Throws `CapabilityRefusedError`. */
    parse(input: Readonly<Record<string, unknown>>): I;
    run(input: I, ctx: { signal: AbortSignal }): Promise<O>;
}

function text(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = input[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function wholeNumber(input: Readonly<Record<string, unknown>>, key: string, fallback?: number): number | undefined {
    const value = input[key];

    if (value === undefined || value === "") {
        return fallback;
    }

    const parsed = typeof value === "number" ? value : Number(value);

    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new CapabilityRefusedError("bad-input", `${key} must be a whole number`);
    }

    return parsed;
}

function list(input: Readonly<Record<string, unknown>>, key: string): string[] {
    const value = input[key];
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/** A CLI-style parser (`hoursArg`, `limitArg`) as a refusal instead of a commander error. */
function parsedWith<T>(raw: string | undefined, key: string, parse: (raw: string) => T): T | undefined {
    if (raw === undefined) {
        return undefined;
    }

    try {
        return parse(raw);
    } catch (err) {
        throw new CapabilityRefusedError("bad-input", `${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export interface AgentsInput {
    hours?: number;
    limit?: number;
    session?: string;
    agent?: string;
}

export interface TranscriptInput {
    query: string;
    limit: number;
    offset?: number;
    provider?: TranscriptProvider;
}

/** Every hub capability the gateway serves. A new one is one entry; the gateway route and the door read this table. */
export const HUB_CAPABILITIES = {
    /** `hub forecast --json`: when each AI account's windows run out (recorded snapshots only, never fetches). */
    forecast: {
        policy: "read",
        rules: READ_ONLY,
        parse: () => ({}),
        async run(_input, { signal }) {
            signal.throwIfAborted();
            const { buildForecast } = await import("../forecast");
            return buildForecast({});
        },
    } satisfies HubCapability<Record<string, never>>,

    /** `hub procs --json`: the agent process monitor's list; a stop stays a CLI process (a write and a confirmation). */
    procs: {
        policy: "read",
        rules: READ_ONLY,
        parse: () => ({}),
        async run(_input, { signal }) {
            signal.throwIfAborted();
            const { readProcsReport } = await import("../procs/sources");
            return readProcsReport({ energy: false });
        },
    } satisfies HubCapability<Record<string, never>>,

    /** `hub stuck check --json --session <id…>`: the verdicts the session badge shows, with the saved thresholds. */
    stuck: {
        policy: "read",
        rules: READ_ONLY,
        parse(input) {
            const sessionIds = list(input, "sessions");

            if (sessionIds.length === 0 || sessionIds.some((id) => id.startsWith("-"))) {
                throw new CapabilityRefusedError("bad-input", "sessions: one or more full session ids");
            }

            return { sessionIds };
        },
        async run({ sessionIds }, { signal }) {
            signal.throwIfAborted();
            const { readStuckThresholds } = await import("../insights/stuck");
            const { stuckSessions } = await import("../insights/index");
            const thresholds = readStuckThresholds();
            const sessions = await stuckSessions({ sessionIds, thresholds });
            return { thresholds, checked: sessions.length, sessions };
        },
    } satisfies HubCapability<{ sessionIds: string[] }>,

    /** `hub agents --json [--session s] [--since d] [--limit n] [--agent id]`: the live agent tree, or one agent. */
    agents: {
        policy: "read",
        rules: READ_ONLY,
        parse(input): AgentsInput {
            return {
                hours: parsedWith(text(input, "since"), "since", hoursArg),
                limit: parsedWith(text(input, "limit"), "limit", limitArg),
                session: text(input, "session"),
                agent: text(input, "agent"),
            };
        },
        async run(input: AgentsInput, { signal }) {
            signal.throwIfAborted();
            const agents = await import("../agents/index");

            if (!input.agent) {
                return agents.hubAgents(input);
            }

            const detail = await agents.hubAgent({ ...input, agent: input.agent });

            if (!detail) {
                const where = input.session ? ` under session ${input.session}` : " in the window";
                throw new CapabilityRefusedError("not-found", `No agent ${input.agent}${where}`);
            }

            return detail;
        },
    } satisfies HubCapability<AgentsInput>,

    /** `ai sessions tail <q> --json [--limit N] [--offset N] [--provider P]`: one page of a session's transcript. */
    transcript: {
        policy: "read",
        rules: READ_ONLY,
        parse(input): TranscriptInput {
            const query = text(input, "query");
            const provider = text(input, "provider");

            if (!query) {
                throw new CapabilityRefusedError("bad-input", "query: a full session id or a transcript path");
            }

            if (provider !== undefined && !isAccountProviderAlias(provider)) {
                throw new CapabilityRefusedError("bad-input", `provider: unknown ${provider}`);
            }

            const limit = wholeNumber(input, "limit", 80) as number;

            if (limit < 1) {
                throw new CapabilityRefusedError("bad-input", "limit must be above 0");
            }

            return { query, limit, offset: wholeNumber(input, "offset"), provider };
        },
        async run(input: TranscriptInput, { signal }) {
            const { resolveTranscript } = await import("@genesiscz/utils/ai/transcripts/resolve");
            const { transcriptEnvelope } = await import("@genesiscz/utils/ai/transcripts/load");
            // A cancel stops the work at each stage: before resolving, and before reading the page.
            signal.throwIfAborted();
            const resolved = await resolveTranscript(input.query, {}, input.provider);
            signal.throwIfAborted();
            return transcriptEnvelope(resolved, { offset: input.offset, limit: input.limit });
        },
    } satisfies HubCapability<TranscriptInput>,

    /** `hub prompts list --json`: the saved prompts with their `{{variables}}`, most used first. */
    prompts: {
        policy: "read",
        rules: READ_ONLY,
        parse: () => ({}),
        async run(_input, { signal }) {
            signal.throwIfAborted();
            const { listPrompts } = await import("../prompts");
            return listPrompts();
        },
    } satisfies HubCapability<Record<string, never>>,

    /** `hub widget snapshot --json [--selected key]`: what the notch widget shows, read once. */
    widgetSnapshot: {
        policy: "read",
        rules: READ_ONLY,
        parse: (input) => ({ selected: text(input, "selected") }),
        async run({ selected }, { signal }) {
            signal.throwIfAborted();
            const { widgetSnapshot } = await import("../widget/snapshot");
            const { oneShotWidgetSources } = await import("../widget/roster-cache");
            return widgetSnapshot({ selectedKey: selected, sources: await oneShotWidgetSources() });
        },
    } satisfies HubCapability<{ selected?: string }>,
} as const;

export type HubCapabilityName = keyof typeof HUB_CAPABILITIES;

/** Parses then runs one capability by name: the one call both adapters make. */
export async function runCapability(
    name: HubCapabilityName,
    input: Readonly<Record<string, unknown>>,
    ctx: { signal: AbortSignal }
): Promise<unknown> {
    const capability: HubCapability = HUB_CAPABILITIES[name];
    return capability.run(capability.parse(input), ctx);
}
