import type { AgentIdentity, CallerHost } from "./types";

/**
 * The identity facts a saved record keeps beside its own core (the failure record's caller, the question hook's dialog
 * record): the session's transcript, the tool call, subagent and turn, the account the caller's harness bills, and the
 * T3 Code host's thread and provider instance. Each a pick of `AgentIdentity`, each optional: a record written before
 * 2026-11-05 has none of them and reads as it always did, so no loader migrates it.
 */
export type RecordedCallerFacts = Partial<
    Pick<AgentIdentity, "transcriptPath" | "toolUseId" | "subagentId" | "turnId" | "account">
> & {
    host?: Pick<CallerHost, "app" | "threadId" | "providerInstanceId">;
};

/** The identity fields `recordedCallerFacts` reads. */
export type RecordedCallerSource = Pick<
    AgentIdentity,
    "transcriptPath" | "toolUseId" | "subagentId" | "turnId" | "account" | "host"
>;

/** The facts the identity has, each only when it is set, so an identity without them gives `{}` and the old shape. */
export function recordedCallerFacts(identity: RecordedCallerSource): RecordedCallerFacts {
    const facts: RecordedCallerFacts = {};

    // A transcript the lookup found; "looked and found none" (null) is no fact worth a field.
    if (identity.transcriptPath) {
        facts.transcriptPath = identity.transcriptPath;
    }

    for (const field of ["toolUseId", "subagentId", "turnId"] as const) {
        const value = identity[field];

        if (value) {
            facts[field] = value;
        }
    }

    if (identity.account) {
        facts.account = identity.account;
    }

    if (identity.host) {
        const { app, threadId, providerInstanceId } = identity.host;
        facts.host = providerInstanceId ? { app, threadId, providerInstanceId } : { app, threadId };
    }

    return facts;
}
