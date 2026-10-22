import { getAgentRuntimeContext } from "@genesiscz/utils/agent/runtime";
import { env } from "@genesiscz/utils/env";
import { failureCaller } from "./caller";
import type { FailureCaller } from "./record";

/**
 * The agent, session, model and checkout of this process, for a failure record. watch.ts loads this module only when
 * it writes a failure, by a path no bundler or type checker follows: the agent runtime reaches the history index, the
 * AI config and the `ai` package, which the CLI helpers must not pull in.
 */
export function agentFailureCaller(): FailureCaller {
    const processEnv = env.getProcessEnv();
    return failureCaller({ context: getAgentRuntimeContext({}, processEnv), processEnv });
}
