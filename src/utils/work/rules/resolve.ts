/**
 * The effective rules of one project. The layers, weak to strong: the built-in defaults, `global.rules` of the
 * machine file, the repository section, `projects.<p>.rules`. Each value keeps the layer that set it.
 */
import type { ItemType, Role, Severity } from "../model/vocab";
import { levelOf, SEVERITIES } from "../model/vocab";
import type { FieldRule, ProjectRules, RoleRule, RoutingRule, RuleField, WriteVerb } from "./config";

export const RULE_LAYERS = ["default", "config.global", "config.repo", "config.project"] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

export interface Resolved<V> {
    value: V;
    from: RuleLayer;
    layers: { layer: RuleLayer; value?: V }[];
}

export interface RuleLayerInput {
    layer: RuleLayer;
    rules: ProjectRules;
}

const ANYONE: RoleRule = "anyone";
const LEAD_OWNER: RoleRule = ["lead", "owner"];

/** The write rules per level (design C, P3): the built-in defaults. */
function defaultWrite(type: ItemType, verb: WriteVerb): RoleRule {
    const level = levelOf(type);

    switch (verb) {
        case "spot":
        case "comment":
        case "log":
        case "reference":
        case "reopen":
            return ANYONE;
        case "claim":
        case "release":
            return level === "container" ? (type === "epic" ? LEAD_OWNER : ANYONE) : level === "note" ? [] : ANYONE;
        case "finish":
            if (type === "epic" || level === "note") {
                return LEAD_OWNER;
            }

            return type === "handoff" ? ["worker", "poster", "owner"] : ANYONE;
        case "edit":
        case "drop":
            if (type === "epic" || level === "note") {
                return LEAD_OWNER;
            }

            return type === "handoff" ? ["poster", "lead", "owner"] : ANYONE;
        case "accept":
            // The design gave lead and owner only. The poster (the session that spotted it) may accept its own find
            // too, because the owner asked not to restrict agents too much (D5); an idea stays the owner's.
            return type === "idea" ? ["owner"] : ["poster", "lead", "owner"];
    }
}

/** Built-in field rules: title and type are required by the store itself; a spotted item recommends these three. */
const DEFAULT_FIELDS: Partial<Record<RuleField, FieldRule>> = {
    where: { level: "recommended", measure: "the file and line, or the screen, where you saw it (path:line)" },
    why: { level: "recommended", measure: "why it is wrong or why it matters, in one sentence" },
    userSees: { level: "recommended", measure: "what a user sees because of it, in one sentence" },
    severity: {
        level: "optional",
        measure:
            "critical: data loss or security. high: a main flow fails. medium: a way around exists. low: cosmetic. Empty: not judged.",
    },
    cost: { level: "optional", measure: "what it costs to do now, only when you judged it" },
};

// biome-ignore lint/suspicious/noThenProperty: the routing rule's shape is { when, then }, a key of the saved config
const DEFAULT_ROUTING: RoutingRule[] = [{ then: { under: "inbox" } }];

function pickTyped<V>(
    layers: readonly RuleLayerInput[],
    type: ItemType,
    read: (rules: ProjectRules, key: ItemType | "*") => V | undefined,
    fallback: V
): Resolved<V> {
    const trail: Resolved<V>["layers"] = [{ layer: "default", value: fallback }];
    let value = fallback;
    let from: RuleLayer = "default";

    for (const { layer, rules } of layers) {
        // A rule for the exact type beats `*` in the same layer.
        const found = read(rules, type) ?? read(rules, "*");
        trail.push({ layer, ...(found !== undefined ? { value: found } : {}) });

        if (found !== undefined) {
            value = found;
            from = layer;
        }
    }

    return { value, from, layers: trail };
}

export interface ResolvedRules {
    field(type: ItemType, field: RuleField): Resolved<FieldRule>;
    mayWrite(type: ItemType, verb: WriteVerb): Resolved<RoleRule>;
    /** The first routing rule of the strongest layer that has a list (a list replaces a weaker list as a whole). */
    routeSpotted(draft: {
        type: ItemType;
        severity?: Severity;
        existedBefore?: boolean;
        production?: boolean;
    }): RoutingRule["then"];
    readonly layers: readonly RuleLayerInput[];
}

function severityRank(severity: Severity | undefined): number {
    return severity === undefined ? Number.POSITIVE_INFINITY : SEVERITIES.indexOf(severity);
}

export function resolveRules(layers: readonly RuleLayerInput[]): ResolvedRules {
    return {
        layers,
        field(type, field) {
            return pickTyped(
                layers,
                type,
                (rules, key) => rules.types?.[key]?.fields?.[field],
                DEFAULT_FIELDS[field] ?? { level: "optional" }
            );
        },
        mayWrite(type, verb) {
            return pickTyped(
                layers,
                type,
                (rules, key) => rules.types?.[key]?.writes?.[verb],
                defaultWrite(type, verb)
            );
        },
        routeSpotted(draft) {
            let list = DEFAULT_ROUTING;

            for (const { rules } of layers) {
                if (rules.routing?.spotted !== undefined) {
                    list = rules.routing.spotted;
                }
            }

            for (const rule of list) {
                const when = rule.when ?? {};
                const matches =
                    (when.type === undefined || when.type.includes(draft.type)) &&
                    (when.minSeverity === undefined ||
                        severityRank(draft.severity) <= severityRank(when.minSeverity)) &&
                    (when.existedBefore === undefined || when.existedBefore === (draft.existedBefore === true)) &&
                    (when.production === undefined || when.production === (draft.production === true));

                if (matches) {
                    return rule.then;
                }
            }

            return { under: "inbox" };
        },
    };
}

export const DEFAULT_RULES = resolveRules([]);

export function allows(rule: RoleRule, roles: readonly Role[]): boolean {
    return rule === "anyone" || rule.some((role) => roles.includes(role));
}
