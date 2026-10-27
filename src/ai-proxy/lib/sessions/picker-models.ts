import { PICKER_ID_PREFIX } from "@app/ai-proxy/lib/sessions/routing";
import type { CodexModelInfo } from "@genesiscz/utils/ai/openai/codex-models";

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

/**
 * What a session's Claude Code reads from `/v1/models` for its `/model` picker (the launcher sets
 * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`): Anthropic's list shape with each Codex model under the id the
 * picker keeps (`PICKER_ID_PREFIX`). The picker's own effort control sets `output_config.effort`, which the proxy
 * honours for an id without an effort suffix.
 */
export function sessionPickerModels(models: CodexModelInfo[]): PickerModelList {
    const data = models.map(
        (model): PickerModel => ({
            type: "model",
            id: `${PICKER_ID_PREFIX}codex/${model.slug}`,
            display_name: `${model.displayName} (Codex)`,
            description: [
                "Codex subscription",
                model.efforts.length > 0 ? `effort ${model.efforts.join("/")}` : undefined,
                `${Math.round(model.usableTokens / 1000)}k window`,
            ]
                .filter(Boolean)
                .join(" · "),
            // Claude Code's list schema carries a date; the Codex catalog has none.
            created_at: new Date(0).toISOString(),
        })
    );

    return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}
