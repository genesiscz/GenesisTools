import { defineAgent } from "eve";
import { EVE_MODEL_CONTEXT_TOKENS, createProxyModel } from "./model";
import { resolveWorldConfig } from "./world";

const world = resolveWorldConfig(process.env);

export default defineAgent({
  model: createProxyModel(process.env),
  modelContextWindowTokens: EVE_MODEL_CONTEXT_TOKENS,
  ...(world.kind === "postgres"
    ? { experimental: { workflow: { world: world.world } } }
    : {}),
});
