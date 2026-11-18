/**
 * The shapes of the work rules: the machine file `~/.genesis-tools/work/config.json` and the `work` section of a
 * repository's `genesis-tools.config.json`. A shape on disk changes only through a migration of this file.
 */
import { z } from "zod";
import { FIELD_NAMES } from "../model/item";
import { ITEM_TYPES, type ItemType, ROLES, type Role, SEVERITIES, type Severity } from "../model/vocab";

export const WORK_CONFIG_VERSION = 2;
export const REPO_WORK_VERSION = 1;

/** The fields a rule may name: the item's own columns and its `fields`. */
export const RULE_FIELDS = ["title", "body", "acceptance", "severity", "for", ...FIELD_NAMES] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

/** The writes a role rule governs. `reference` is a link that is not `parent`. */
export const WRITE_VERBS = [
    "spot",
    "comment",
    "log",
    "reference",
    "claim",
    "release",
    "finish",
    "edit",
    "drop",
    "accept",
    "reopen",
] as const;
export type WriteVerb = (typeof WRITE_VERBS)[number];

export const NOTIFY_ACTIONS = [
    "spotted",
    "accepted",
    "claimed",
    "finished",
    "reopened",
    "reopen-undelivered",
    "dropped",
    "commented",
    "sync-held",
    "sync-failed",
] as const;
export type NotifyAction = (typeof NOTIFY_ACTIONS)[number];
export const NOTIFY_LEVELS = ["off", "list", "inbox", "banner"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];
export const NOTIFY_SURFACES = ["hub", "widget"] as const;
export type NotifySurface = (typeof NOTIFY_SURFACES)[number];

const levelSchema = z.enum(["required", "recommended", "optional"]);
const fieldRuleSchema = z.object({ level: levelSchema, measure: z.string().optional() });
const roleRuleSchema = z.union([z.literal("anyone"), z.array(z.enum(ROLES))]);
const typeKey = z.union([z.enum(ITEM_TYPES), z.literal("*")]);

const typeRulesSchema = z.object({
    fields: z.partialRecord(z.enum(RULE_FIELDS), fieldRuleSchema).optional(),
    writes: z.partialRecord(z.enum(WRITE_VERBS), roleRuleSchema).optional(),
});

const routingRuleSchema = z.object({
    when: z
        .object({
            type: z.array(z.enum(ITEM_TYPES)).optional(),
            minSeverity: z.enum(SEVERITIES).optional(),
            existedBefore: z.boolean().optional(),
            production: z.boolean().optional(),
        })
        .optional(),
    // biome-ignore lint/suspicious/noThenProperty: the routing rule's shape is { when, then }, a key of the saved config
    then: z.object({
        under: z.string().optional(),
        accept: z.boolean().optional(),
        notify: z.enum(NOTIFY_LEVELS).optional(),
    }),
});

const notifyRuleSchema = z.union([
    z.enum(NOTIFY_LEVELS),
    z.object({ level: z.enum(NOTIFY_LEVELS), minSeverity: z.enum(SEVERITIES) }),
]);

export const projectRulesSchema = z.object({
    types: z.partialRecord(typeKey, typeRulesSchema).optional(),
    routing: z.object({ spotted: z.array(routingRuleSchema).optional() }).optional(),
    notify: z.partialRecord(typeKey, z.partialRecord(z.enum(NOTIFY_ACTIONS), notifyRuleSchema)).optional(),
    /** Each connector owns the shape of its own section (P5); here it is only an object. */
    connectors: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

const surfaceRulesSchema = projectRulesSchema.pick({ notify: true }).strict();

export const workConfigFileSchema = z.object({
    version: z.literal(WORK_CONFIG_VERSION),
    machine: z.object({ prefix: z.string().optional() }).optional(),
    global: z.object({ rules: projectRulesSchema.optional() }).optional(),
    projects: z
        .record(
            z.string(),
            z.object({
                roots: z.array(z.string()).optional(),
                prefix: z.string().optional(),
                rules: projectRulesSchema.optional(),
                surfaces: z.partialRecord(z.enum(NOTIFY_SURFACES), surfaceRulesSchema).optional(),
            })
        )
        .optional(),
});

export const repoWorkSectionSchema = z.object({
    version: z.literal(REPO_WORK_VERSION),
    key: z.string().optional(),
    prefix: z.string().optional(),
    rules: projectRulesSchema.optional(),
});

export type FieldRule = z.infer<typeof fieldRuleSchema>;
export type RoleRule = z.infer<typeof roleRuleSchema>;
export type TypeRules = z.infer<typeof typeRulesSchema>;
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type NotifyRule = z.infer<typeof notifyRuleSchema>;
export type ProjectRules = z.infer<typeof projectRulesSchema>;
export type WorkConfigFile = z.infer<typeof workConfigFileSchema>;
export type RepoWorkSection = z.infer<typeof repoWorkSectionSchema>;

/** Pure: one step of the shape. `run` gets the raw object of version `from` and returns version `to`. */
export interface WorkConfigMigration {
    from: number;
    to: number;
    id: string;
    describe: string;
    run(raw: Record<string, unknown>): Record<string, unknown>;
}

export const WORK_CONFIG_MIGRATIONS: readonly WorkConfigMigration[] = [
    {
        from: 1,
        to: 2,
        id: "project-surface-notify",
        describe: "Each project can override notification levels for the hub and widget.",
        // Version 1 had no surface preferences. An absent override inherits the project's level.
        run: (raw) => raw,
    },
];

export type MigrateResult =
    | { ok: true; raw: Record<string, unknown>; migrated: string[] }
    | { ok: false; newer: number }
    | { ok: false; problem: string };

/** Runs each migration whose `from` matches, in order. A second run changes nothing; a newer version is not guessed. */
export function migrateWorkConfig(
    raw: unknown,
    chain: readonly WorkConfigMigration[] = WORK_CONFIG_MIGRATIONS,
    current: number = WORK_CONFIG_VERSION
): MigrateResult {
    const object = z.record(z.string(), z.unknown()).safeParse(raw);

    if (!object.success) {
        return { ok: false, problem: "the file is not a JSON object" };
    }

    let doc: Record<string, unknown> = object.data;
    let version = typeof doc.version === "number" ? doc.version : 1;
    const migrated: string[] = [];

    if (version > current) {
        return { ok: false, newer: version };
    }

    for (const step of chain) {
        if (step.from === version && step.to <= current) {
            doc = { ...step.run(doc), version: step.to };
            version = step.to;
            migrated.push(step.id);
        }
    }

    return { ok: true, raw: { ...doc, version }, migrated };
}

export type { ItemType, Role, Severity };
