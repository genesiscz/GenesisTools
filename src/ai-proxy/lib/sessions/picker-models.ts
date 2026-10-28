import type { ModelFacts, ProviderBilling } from "@app/ai-proxy/lib/providers/definition";
import { PROVIDER_DEFINITIONS, providerTypes } from "@app/ai-proxy/lib/providers/registry";
import {
    type AiProxySessionRecord,
    SESSION_ACCOUNT_FIELD,
    type SessionAgent,
    sessionAccountName,
} from "@app/ai-proxy/lib/sessions/records";
import { PICKER_ID_SUFFIX } from "@app/ai-proxy/lib/sessions/routing";

export interface PickerModel {
    type: "model";
    id: string;
    display_name: string;
    description: string;
    created_at: string;
}

export interface PickerModelList {
    data: PickerModel[];
    has_more: false;
    first_id: string | null;
    last_id: string | null;
}

/** One provider's models in a session's picker, under the agent whose prefix routes them (`codex/<id>`). */
export interface PickerModelGroup {
    agent: SessionAgent;
    label: string;
    plane: ProviderBilling["plane"];
    models: readonly ModelFacts[];
}

function isSessionAgent(agent: string): agent is SessionAgent {
    return Object.hasOwn(SESSION_ACCOUNT_FIELD, agent);
}

/**
 * The model facts of every provider that keeps them (`ModelSource.facts`), for each agent the session has an account
 * or a login for: the picker lists only models the session can route.
 */
export function sessionPickerGroups(record: AiProxySessionRecord): PickerModelGroup[] {
    return providerTypes().flatMap((type) => {
        const { agent, billing, models } = PROVIDER_DEFINITIONS[type];

        if (!models.facts || !isSessionAgent(agent) || !sessionAccountName(record, agent)) {
            return [];
        }

        return [{ agent, label: models.facts.label, plane: billing.plane, models: models.facts.listed() }];
    });
}

/**
 * What a session's Claude Code reads from `/v1/models` for its `/model` picker (the launcher sets
 * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`): Anthropic's list shape with each model under the id the picker keeps
 * (`<agent>-claude/<id>`, `PICKER_ID_SUFFIX`). The picker's own effort control sets `output_config.effort`, which the
 * proxy honours for an id without an effort suffix.
 */
export function sessionPickerModels({
    groups,
    contextLimit,
}: {
    groups: readonly PickerModelGroup[];
    contextLimit?: number;
}): PickerModelList {
    // Unknown launch limits cannot safely admit a smaller model.
    const knownLimit = typeof contextLimit === "number" && Number.isFinite(contextLimit) && contextLimit > 0;
    const data = groups.flatMap((group) =>
        (knownLimit ? group.models.filter((model) => model.usableTokens >= contextLimit) : []).map(
            (model): PickerModel => ({
                type: "model",
                id: `${group.agent}${PICKER_ID_SUFFIX}/${model.slug}`,
                display_name: `${model.displayName} (${group.label})`,
                description: [
                    `${group.label} ${group.plane}`,
                    model.efforts.length > 0 ? `effort ${model.efforts.join("/")}` : undefined,
                    `${Math.round(model.window / 1000)}k window`,
                ]
                    .filter(Boolean)
                    .join(" · "),
                // Claude Code's list schema carries a date; a model catalog has none.
                created_at: new Date(0).toISOString(),
            })
        )
    );

    return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}
