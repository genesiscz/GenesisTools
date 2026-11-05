import {
    type AgentIdentity,
    type CallerInput,
    type WhoIsCallingOptions,
    whoIsCalling,
} from "@genesiscz/utils/agent/identity";
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
