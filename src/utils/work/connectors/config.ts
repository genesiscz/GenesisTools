/**
 * The part of a connector's config section that every connector shares: on or off, its own settings, the label
 * template, which types it makes outside, and who may push. A later layer wins key by key (machine global, the
 * repository section, the project); `settings` is the connector's own shape and is checked by its schema.
 */
import { z } from "zod";
import { ITEM_TYPES, type ItemType, ROLES, type Role } from "../model/vocab";
import type { RuleLayerInput } from "../rules/resolve";
import type { ConnectorConfig } from "./sync";
import { DEFAULT_LABEL_TEMPLATE } from "./types";

const roleRule = z.union([z.literal("anyone"), z.array(z.enum(ROLES))]);

export const connectorSectionSchema = z.object({
    enabled: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    labelTemplate: z.string().optional(),
    createTypes: z.array(z.enum(ITEM_TYPES)).optional(),
    push: z.partialRecord(z.enum(ITEM_TYPES), roleRule).optional(),
});

export type ConnectorSection = z.infer<typeof connectorSectionSchema>;

export interface ConnectorConfigResult {
    config: ConnectorConfig | null;
    problems: string[];
}

/** Merges the sections of one connector over the layers; null when no layer names it. */
export function connectorConfigOf(layers: readonly RuleLayerInput[], connector: string): ConnectorConfigResult {
    const merged: ConnectorSection = {};
    const problems: string[] = [];
    let named = false;

    for (const layer of layers) {
        const raw = layer.rules.connectors?.[connector];

        if (raw === undefined) {
            continue;
        }

        const parsed = connectorSectionSchema.safeParse(raw);

        if (!parsed.success) {
            problems.push(`${layer.layer}: connectors.${connector}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
            continue;
        }

        named = true;
        const { settings, push, ...rest } = parsed.data;
        Object.assign(merged, rest);

        if (settings !== undefined) {
            merged.settings = { ...merged.settings, ...settings };
        }

        if (push !== undefined) {
            merged.push = { ...merged.push, ...push };
        }
    }

    if (!named || problems.length > 0) {
        return { config: null, problems };
    }

    const push = merged.push ?? {};
    return {
        config: {
            enabled: merged.enabled ?? false,
            settings: merged.settings ?? {},
            labelTemplate: merged.labelTemplate ?? DEFAULT_LABEL_TEMPLATE,
            createTypes: merged.createTypes ?? [],
            push: (type: ItemType): readonly Role[] | "anyone" | undefined => push[type],
        },
        problems,
    };
}
