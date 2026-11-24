import {
    type AgentIdentity,
    type CallerInput,
    type WhoIsCallingOptions,
    whoIsCalling,
} from "@genesiscz/utils/agent/identity";
import { CALLER_RECORD_FACETS, type CallerRecord, callerRecordOf } from "@genesiscz/utils/agent/identity/caller-record";
import { currentCaller } from "@genesiscz/utils/agent/runtime";
import { env as appEnv } from "@genesiscz/utils/env";

/** The facets a posted record's stamp needs: the live folder, its git facts and the session's title. */
export const STAMP_FACETS = ["cwd", "git", "title"] as const;

export interface CallerHereOptions extends WhoIsCallingOptions {
    /** The environment of a local caller. Tests pass one; production reads the live process. Ignored in a request scope. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Who is calling this code right now: inside a request scope (`runAsCaller`, the MCP gateway) the scoped caller
 * and nothing of this process's env; otherwise the local environment. This is the one place that picks the input, so
 * a caller never branches on the scope itself. It fills no facet unless asked (`facets: STAMP_FACETS` for a stamp).
 */
export function whoIsCallingHere({ env, ...options }: CallerHereOptions = {}): AgentIdentity {
    const scoped = currentCaller();
    const input: CallerInput = scoped
        ? { origin: "remote", caller: scoped }
        : { origin: "local", env: env ?? appEnv.getProcessEnv() };

    return whoIsCalling(input, options);
}

let localRecord: CallerRecord | undefined;

/**
 * Who decides on this call, as a decision keeps it (`CallerRecord`): the identity with `CALLER_RECORD_FACETS`. A
 * local caller's record is read once per process, since its session, folder and terminal do not change while it runs;
 * a caller in a request scope (the MCP gateway) is read for each request. Tests pass `env` and get a fresh read.
 */
export function callerRecordHere(options: Pick<CallerHereOptions, "env" | "now" | "home"> = {}): CallerRecord {
    const scoped = currentCaller() !== undefined;
    const fresh = scoped || Object.keys(options).length > 0;

    if (!fresh && localRecord) {
        return localRecord;
    }

    const record = callerRecordOf(whoIsCallingHere({ ...options, facets: CALLER_RECORD_FACETS }));

    if (!fresh) {
        localRecord = record;
    }

    return record;
}

/**
 * The caller's record when the caller is an agent, else undefined: a person's command reads nothing beyond its
 * environment. What a decision store keeps as "who stored this answer".
 */
export function agentRecordHere(
    options: Pick<CallerHereOptions, "env" | "now" | "home"> = {}
): CallerRecord | undefined {
    const who = whoIsCallingHere({ env: options.env });
    return who.isInAgent && who.agent !== "unknown" ? callerRecordHere(options) : undefined;
}
