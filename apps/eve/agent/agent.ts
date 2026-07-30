import { defineAgent } from "eve";
import { agentEnv } from "./lib/env";
import { EVE_MODEL_CONTEXT_TOKENS, createProxyModel } from "./model";
import { resolveWorldConfig } from "./world";

const world = resolveWorldConfig(agentEnv);

export default defineAgent({
  model: createProxyModel(agentEnv),
  modelContextWindowTokens: EVE_MODEL_CONTEXT_TOKENS,
  ...(world.kind === "postgres"
    ? { experimental: { workflow: { world: world.world } } }
    : {}),
});
