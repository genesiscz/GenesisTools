import { env } from "@genesiscz/utils/env";
import { failureCaller } from "./caller";
import type { FailureCaller } from "./record";

/**
 * The agent, session, model and checkout of this process, for a failure record: the agent identity module read from
 * this process's own environment. watch.ts loads this module only when it writes a failure, by a path no bundler or
 * type checker follows: the identity module reaches the history index, the AI config and the `ai` package, which the
 * CLI helpers must not pull in.
 */
export function agentFailureCaller(): FailureCaller {
    return failureCaller({ processEnv: env.getProcessEnv() });
}
