import { type AgentIdentity, type WhoIsCallingOptions, whoIsCalling } from "@genesiscz/utils/agent/identity";
import { type HookPayload, hookCallerFacts } from "./payload";

/**
 * Who ran a hook: the payload names the caller ahead of the environment the hook process inherited, through the
 * identity module's one precedence rule. A subagent's call keeps its own agent id, tool call and transcript, while the
 * env (the parent's session variable, its effort) only fills what the payload leaves empty for the same caller. Kept
 * out of `payload.ts`, which every hook loads at its start: only a hook that writes a record loads the identity module.
 */
export function hookCaller(payload: HookPayload, env: NodeJS.ProcessEnv, options?: WhoIsCallingOptions): AgentIdentity {
    return whoIsCalling({ origin: "local", env, hook: hookCallerFacts(payload) }, options);
}
