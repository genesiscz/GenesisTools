import { logger } from "@genesiscz/utils/logger";
import { parseWebLogFile, readWebLogFiles, type WebLogLine } from "./web-log";

const log = logger.scoped("ms-teams").log;

/** A chat-list error newer than this, before the end of the log, counts as current. */
const RECENT_MS = 30 * 60_000;

/** The token resources the chat list needs. A sign-in failure on one of them is what empties the chat pane. */
const CHAT_RESOURCES = new Set([
    "https://api.spaces.skype.com",
    "https://chatsvcagg.teams.microsoft.com",
    "https://ic3.teams.office.com",
]);

const RESOURCE_LABELS: Record<string, string> = {
    "https://api.spaces.skype.com": "Teams middle tier: chat list, people, settings",
    "https://chatsvcagg.teams.microsoft.com": "chat service aggregator",
    "https://ic3.teams.office.com": "messaging",
    "https://presence.teams.microsoft.com/": "presence",
    "https://loki.delve.office.com/": "profile cards",
    "https://outlook.office.com": "calendar and mail",
    "https://substrate.office.com": "search and Microsoft 365 data",
    "https://graph.microsoft.com": "Microsoft Graph",
};

/** The errors that mean a silent renew is impossible and the user has to sign in again in the app. */
const SIGN_IN_ERRORS = new Set(["InteractionRequired", "interaction_required", "invalid_grant", "token_expired"]);

/** The GraphQL query that fills the chat list. Other operations fail routinely (calendar, rooms) and mean nothing here. */
const CHAT_LIST_OPERATION = /LeftRail/i;

const TELEMETRY_RE = /\[Telemetry\]\[([0-9a-f-]{36})\]\[([\w-]+)\]/i;
const STEP_RE = /^\s*(\[[\w-]+\](?:\[[\w-]+\])?)/;
const RESOURCE_RE = /(?:endpointUrl|target)\\*"\s*:\s*\\*"([^"\\]+)/;
const GRAPHQL_RE = /Uncaught error in a GraphQL resolver for operation \\*"(\w+)/;
const REDUCED_RE = /REDUCED_CAPABILITIES_(\w+)/;
const FAILED_RE =
    /operationStatus\\*"\s*:\s*\\*"FAILED|\\*"status\\*"\s*:\s*\\*"(?:incomplete|failure|failed)\\*"|status:FAILED/i;
const SUCCESS_RE = /\\*"status\\*"\s*:\s*\\*"success\\*"/;

export type TokenOutcome = "success" | "failed";

export interface ResourceHealth {
    resource: string;
    label: string | null;
    successes: number;
    failures: number;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    /** Error codes of the failures: `invalid_grant`, `token_expired`, `InteractionRequired`, `AADSTS…`. */
    errors: string[];
    /** The newest renew failed with a sign-in error and nothing renewed after it. */
    needsSignIn: boolean;
    chatCritical: boolean;
}

export interface GraphQlFailure {
    operation: string;
    count: number;
    firstAt: number;
    lastAt: number;
}

export type AuthVerdict = "healthy" | "needs-sign-in" | "chat-errors" | "other-sign-in" | "no-log";

export interface TeamsAuthHealth {
    files: number;
    lines: number;
    windowStart: number | null;
    windowEnd: number | null;
    resources: ResourceHealth[];
    graphql: GraphQlFailure[];
    reducedCapabilities: Array<{ name: string; lastAt: number }>;
    verdict: AuthVerdict;
}

interface RenewGroup {
    scenario: string;
    steps: string[];
    payload: string[];
    at: number;
}

interface RenewAttempt {
    resource: string | null;
    at: number;
    outcome: TokenOutcome | null;
    errors: string[];
}

/** Read the live Teams web-client log and judge whether its token renews and its chat queries work. Read-only. */
export function readAuthHealth(root: string): TeamsAuthHealth {
    const lines: WebLogLine[] = [];
    let files = 0;

    for (const { path, text } of readWebLogFiles(root)) {
        if (!text.includes("[Telemetry]") && !text.includes("GraphQL resolver") && !text.includes("REDUCED_CAPAB")) {
            continue;
        }

        try {
            lines.push(...parseWebLogFile(text));
            files++;
        } catch (err) {
            log.debug(
                { err, path },
                "[ms-teams] skipped a web-client log file that is not JSON (Teams may be writing it)"
            );
        }
    }

    const health = collectAuthHealth(lines);
    log.debug(
        { root, files, lines: lines.length, verdict: health.verdict, resources: health.resources.length },
        "[ms-teams] read web-client auth health"
    );

    return { ...health, files };
}

/** Judge token renews and chat-query errors from web-client log lines in any order. */
export function collectAuthHealth(lines: WebLogLine[]): Omit<TeamsAuthHealth, "files"> {
    const sorted = [...lines].sort((a, b) => a.at - b.at);
    const groups = new Map<string, RenewGroup>();
    const graphql = new Map<string, GraphQlFailure>();
    const reduced = new Map<string, number>();

    for (const line of sorted) {
        const telemetry = TELEMETRY_RE.exec(line.message);

        if (telemetry) {
            addTelemetryLine(groups, telemetry, line);
            continue;
        }

        const op = GRAPHQL_RE.exec(line.message)?.[1];

        if (op) {
            const prev = graphql.get(op);
            graphql.set(op, {
                operation: op,
                count: (prev?.count ?? 0) + 1,
                firstAt: prev?.firstAt ?? line.at,
                lastAt: line.at,
            });
        }

        const reducedName = REDUCED_RE.exec(line.message)?.[1];

        if (reducedName) {
            reduced.set(reducedName, line.at);
        }
    }

    const attempts = [...groups.values()].map(toAttempt);
    const resources = summarizeResources(attempts);
    const windowStart = sorted[0]?.at ?? null;
    const windowEnd = sorted.at(-1)?.at ?? null;
    const graphqlList = [...graphql.values()].sort((a, b) => b.lastAt - a.lastAt);

    return {
        lines: sorted.length,
        windowStart,
        windowEnd,
        resources,
        graphql: graphqlList,
        reducedCapabilities: [...reduced.entries()].map(([name, lastAt]) => ({ name, lastAt })),
        verdict: judge({ lines: sorted.length, windowEnd, resources, graphql: graphqlList, reduced }),
    };
}

function addTelemetryLine(groups: Map<string, RenewGroup>, match: RegExpExecArray, line: WebLogLine): void {
    const [tag, id, scenario] = match;
    const group = groups.get(id) ?? { scenario, steps: [], payload: [], at: line.at };
    const rest = line.message.slice(match.index + tag.length);
    const step = STEP_RE.exec(rest)?.[1];

    if (step) {
        group.steps.push(step);
    }

    // One renew is logged in chunks that can split a field, so the payloads are joined before matching.
    const marker = rest.search(/\[scenarioEventData\]|\[e\]/);
    group.payload.push(marker >= 0 ? rest.slice(marker).replace(/^\[scenarioEventData\]|^\[e\]/, "") : rest);
    group.at = Math.max(group.at, line.at);
    groups.set(id, group);
}

function toAttempt(group: RenewGroup): RenewAttempt {
    const joined = group.payload.join("");
    const failed =
        group.steps.some((s) => /\[stop\]\[(?:incomplete|failure|failed)\]/i.test(s)) || FAILED_RE.test(joined);
    const succeeded = group.steps.some((s) => /\[stop\]\[success\]/i.test(s)) || SUCCESS_RE.test(joined);
    const outcome: TokenOutcome | null = failed ? "failed" : succeeded ? "success" : null;

    return {
        resource: RESOURCE_RE.exec(joined)?.[1] ?? null,
        at: group.at,
        outcome,
        errors: failed ? errorCodes(joined) : [],
    };
}

function errorCodes(text: string): string[] {
    const found = new Set<string>();

    for (const m of text.matchAll(/Code: '(\w+)'/g)) {
        found.add(m[1]);
    }

    for (const m of text.matchAll(/suberror: '(\w+)'/g)) {
        found.add(m[1]);
    }

    for (const m of text.matchAll(/errorCode\\*"?\s*:\s*\\*"?([A-Za-z_]+)/g)) {
        found.add(m[1]);
    }

    for (const m of text.matchAll(/AADSTS\d+/g)) {
        found.add(m[0]);
    }

    const codes = [...found];
    return codes.filter((code) => !codes.some((other) => other !== code && other.startsWith(code)));
}

function summarizeResources(attempts: RenewAttempt[]): ResourceHealth[] {
    const byResource = new Map<string, ResourceHealth>();

    for (const attempt of attempts) {
        if (!attempt.resource || !attempt.outcome) {
            continue;
        }

        const row = byResource.get(attempt.resource) ?? {
            resource: attempt.resource,
            label: RESOURCE_LABELS[attempt.resource] ?? null,
            successes: 0,
            failures: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            errors: [],
            needsSignIn: false,
            chatCritical: CHAT_RESOURCES.has(attempt.resource),
        };

        if (attempt.outcome === "success") {
            row.successes++;
            row.lastSuccessAt = Math.max(row.lastSuccessAt ?? 0, attempt.at);
        } else {
            row.failures++;
            row.lastFailureAt = Math.max(row.lastFailureAt ?? 0, attempt.at);
            row.errors = [...new Set([...row.errors, ...attempt.errors])];
        }

        byResource.set(attempt.resource, row);
    }

    for (const row of byResource.values()) {
        const failedLast = row.lastFailureAt !== null && row.lastFailureAt > (row.lastSuccessAt ?? 0);
        row.needsSignIn = failedLast && row.errors.some((code) => SIGN_IN_ERRORS.has(code));
    }

    return [...byResource.values()].sort(
        (a, b) =>
            Number(b.needsSignIn) - Number(a.needsSignIn) ||
            Number(b.chatCritical) - Number(a.chatCritical) ||
            b.failures - a.failures ||
            a.resource.localeCompare(b.resource)
    );
}

function judge(input: {
    lines: number;
    windowEnd: number | null;
    resources: ResourceHealth[];
    graphql: GraphQlFailure[];
    reduced: Map<string, number>;
}): AuthVerdict {
    if (input.lines === 0 || input.windowEnd === null) {
        return "no-log";
    }

    if (input.resources.some((r) => r.needsSignIn && r.chatCritical)) {
        return "needs-sign-in";
    }

    const windowEnd = input.windowEnd;

    const chatListFails = input.graphql.some(
        (g) => CHAT_LIST_OPERATION.test(g.operation) && windowEnd - g.lastAt <= RECENT_MS
    );
    const chatsReduced = windowEnd - (input.reduced.get("CHATS") ?? Number.NEGATIVE_INFINITY) <= RECENT_MS;

    if (chatListFails || chatsReduced) {
        return "chat-errors";
    }

    if (input.resources.some((r) => r.needsSignIn)) {
        return "other-sign-in";
    }

    return "healthy";
}
