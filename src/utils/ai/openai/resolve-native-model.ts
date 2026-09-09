import { AiConfigStore } from "../config/AiConfigStore";
import { parseModelRef } from "../core/model-ref";
import { resolveModelTarget } from "../core/resolve";
import { resolveProviderAlias } from "../providers/aliases";
import { resolveOpenAiSubModel } from "./sub-models";

/** Interpret shared aliases without binding credentials or changing the launch account. */
export async function resolveNativeCodexModel(accountId: string, input: string): Promise<string> {
    const store = await AiConfigStore.readOnly();
    const parsed = parseModelRef(input, store.data());
    if (parsed.kind === "proxy") {
        throw new Error("Native Codex model selection cannot switch to a proxy provider");
    }
    if (parsed.providerId && resolveProviderAlias(parsed.providerId) !== "openai-sub") {
        throw new Error("Native Codex model selection cannot switch provider");
    }
    if (parsed.accountId && store.account(parsed.accountId)?.id !== accountId) {
        throw new Error("Native Codex model selection cannot switch the selected account");
    }
    if (!parsed.modelId) {
        throw new Error("Specify a model ID or model alias");
    }
    const model = resolveOpenAiSubModel(parsed.modelId);
    const target = await resolveModelTarget(`@account/${accountId}:${model}`, { store, app: "codex" });
    if (target.account.id !== accountId || target.plugin.id !== "openai-sub") {
        throw new Error("Native Codex model selection changed the selected account or provider");
    }
    return target.model.id;
}
