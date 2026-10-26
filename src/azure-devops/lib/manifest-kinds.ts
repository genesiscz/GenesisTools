import type { Api } from "@app/azure-devops/api";
import type { IterationClassificationNode } from "@app/azure-devops/api.types";
import { type AdoManifest, diffManifestData, isRecord, sortedRecord } from "@app/azure-devops/lib/ado-manifest";
import {
    type AdoFieldManifest,
    type AdoTypeEntry,
    buildFieldManifest,
    diffManifests,
    renderManifestMd,
} from "@app/azure-devops/lib/field-manifest";
import { concurrentMap } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** One kind of manifest: how to read it from ADO and, where the generic forms do not fit, how to show and diff it. */
export interface ManifestKind {
    kind: string;
    /** The constant a .ts file exports; `sync --prefix` puts the prefix in front. */
    exportName: string;
    description: string;
    /** `--types` narrows it to some work item types. */
    usesTypes: boolean;
    fetch(context: { api: Api; types?: string[] }): Promise<Record<string, unknown>>;
    renderMd?(manifest: AdoManifest & Record<string, unknown>): string;
    diff?(saved: AdoManifest & Record<string, unknown>, live: AdoManifest & Record<string, unknown>): string[];
}

/** `\Project\Area\Team` → `Project\Team`, the form `System.AreaPath` and WIQL use. */
export function toAreaPath(nodePath: string): string {
    return nodePath.replace(/^\\/, "").replace(/\\Area(\\|$)/, "$1");
}

export function flattenAreaPaths(root: IterationClassificationNode): string[] {
    const paths: string[] = [];

    const walk = (node: IterationClassificationNode): void => {
        paths.push(toAreaPath(node.path));

        for (const child of node.children ?? []) {
            walk(child);
        }
    };

    walk(root);
    return paths.sort();
}

/** One rule of an inherited process (`_apis/work/processes/<id>/workItemTypes/<ref>/rules`). */
export interface ProcessRule {
    name: string;
    isDisabled?: boolean;
    conditions?: { conditionType: string; field?: string; value?: string }[];
    actions?: { actionType: string; targetField?: string; value?: string }[];
}

export interface WorkflowEntry {
    initial: string[];
    transitions: Record<string, string[]>;
    /** Rules that change the allowed states under other conditions (a group, another field); not applied above. */
    conditionalRules: string[];
}

function disallowedStates(rule: ProcessRule): string[] {
    return (rule.actions ?? [])
        .filter((action) => action.actionType === "disallowValue" && action.targetField === "System.State")
        .map((action) => action.value ?? "");
}

/**
 * The states each state may move to. The type's own transition map lists every state in an inherited process; the
 * board enforces the order through rules of the form "when System.State was X, disallow these states", so those
 * rules are subtracted here. Staying in the same state is not listed. `""` in the transition map holds the states a new
 * work item may start in.
 */
export function buildWorkflow(transitions: Record<string, { to: string }[]>, rules: ProcessRule[] = []): WorkflowEntry {
    const disallowed = new Map<string, Set<string>>();
    const conditionalRules: string[] = [];

    for (const rule of rules) {
        const states = disallowedStates(rule);

        if (rule.isDisabled || states.length === 0) {
            continue;
        }

        const [condition, ...others] = rule.conditions ?? [];

        if (
            !condition ||
            others.length > 0 ||
            condition.conditionType !== "whenWas" ||
            condition.field !== "System.State"
        ) {
            conditionalRules.push(rule.name);
            continue;
        }

        const from = condition.value ?? "";
        const set = disallowed.get(from) ?? new Set<string>();

        for (const state of states) {
            set.add(state);
        }

        disallowed.set(from, set);
    }

    const targets = (from: string): string[] =>
        (transitions[from] ?? [])
            .map((step) => step.to)
            .filter((to) => to !== from && !disallowed.get(from)?.has(to))
            .sort();
    const states = Object.keys(transitions).filter((from) => from !== "");

    return {
        initial: targets(""),
        transitions: sortedRecord(states.map((from): [string, string[]] => [from, targets(from)])),
        conditionalRules: conditionalRules.sort(),
    };
}

function isFieldManifest(
    manifest: AdoManifest & Record<string, unknown>
): manifest is AdoFieldManifest & Record<string, unknown> {
    return (
        isRecord(manifest.types) &&
        Object.values(manifest.types).every(
            (type): type is AdoTypeEntry => isRecord(type) && isRecord(type.fields) && Array.isArray(type.states)
        )
    );
}

async function fetchFieldTypes(api: Api, typeNames: string[]): Promise<Record<string, unknown>> {
    const failures: string[] = [];
    const [catalog, fetched] = await Promise.all([
        api.getFieldCatalog(),
        concurrentMap({
            items: typeNames,
            concurrency: 4,
            fn: async (name) => {
                const [fields, states] = await Promise.all([
                    api.getWorkItemTypeFields(name),
                    api.getWorkItemTypeStates(name),
                ]);
                return { name, fields, states };
            },
            onError: (name, error) => failures.push(`${name}: ${error instanceof Error ? error.message : error}`),
        }),
    ]);

    // A type that failed to load would read as "removed" in a check, so a partial manifest is never written.
    if (failures.length > 0) {
        throw new Error(`Could not read ${failures.length} work item type(s):\n  ${failures.join("\n  ")}`);
    }

    const placeholderMeta = { org: "", project: "", process: null, fetchedAt: "", regenerate: "" };
    return { types: buildFieldManifest({ meta: placeholderMeta, catalog, types: [...fetched.values()] }).types };
}

export const MANIFEST_KINDS: ManifestKind[] = [
    {
        kind: "fields",
        exportName: "AdoFields",
        description: "Every field of each work item type (label, data type, allowed values) and the type's states",
        usesTypes: true,
        fetch: async ({ api, types }) => fetchFieldTypes(api, types ?? (await api.getAvailableWorkItemTypes())),
        renderMd: (manifest) => (isFieldManifest(manifest) ? renderManifestMd(manifest) : renderGenericMd(manifest)),
        diff: (saved, live) =>
            isFieldManifest(saved) && isFieldManifest(live)
                ? diffManifests(saved, live)
                : diffManifestData(saved, live),
    },
    {
        kind: "workflow",
        exportName: "AdoWorkflow",
        description: "Per work item type: the states a new item may start in and which state may follow which",
        usesTypes: true,
        fetch: async ({ api, types }) => {
            const wanted = types ? new Set(types.map((type) => type.toLowerCase())) : null;
            const [definitions, process] = await Promise.all([
                api.getWorkItemTypeDefinitions(),
                api.getProjectProcess(),
            ]);
            const chosen = definitions.filter((definition) => !wanted || wanted.has(definition.name.toLowerCase()));
            const processTypes = process ? await api.getProcessWorkItemTypes(process.id) : [];
            const refByName = new Map(processTypes.map((type) => [type.name, type.referenceName]));
            const entries = await Promise.all(
                chosen.map(async (definition): Promise<[string, WorkflowEntry]> => {
                    const ref = refByName.get(definition.name);
                    const rules = process && ref ? await api.getProcessRules(process.id, ref) : [];
                    return [definition.name, buildWorkflow(definition.transitions ?? {}, rules)];
                })
            );

            return { types: sortedRecord(entries) };
        },
    },
    {
        kind: "sprints",
        exportName: "AdoSprints",
        description: "Every dated iteration (sprint) by its iteration path, with its id and dates",
        usesTypes: false,
        fetch: async ({ api }) => {
            const iterations = await api.getProjectIterations();
            return {
                sprints: sortedRecord(
                    iterations.map((iteration) => [
                        iteration.path,
                        {
                            id: iteration.id,
                            start: iteration.attributes?.startDate ?? null,
                            finish: iteration.attributes?.finishDate ?? null,
                        },
                    ])
                ),
            };
        },
    },
    {
        kind: "areas",
        exportName: "AdoAreas",
        description: "Every area path of the project",
        usesTypes: false,
        fetch: async ({ api }) => ({ areas: flattenAreaPaths(await api.getAreaNodes()) }),
    },
    {
        kind: "queries",
        exportName: "AdoQueries",
        description: "Every shared saved query by its folder path, with its id (My Queries are left out)",
        usesTypes: false,
        fetch: async ({ api }) => {
            const queries = (await api.getAllQueries()).filter(
                (query) => !query.isFolder && !query.path.startsWith("My Queries/")
            );
            return { queries: sortedRecord(queries.map((query) => [query.path, query.id])) };
        },
    },
    {
        kind: "identities",
        exportName: "AdoIdentities",
        description: "Every member of the project's teams by unique name, with display name, id and teams",
        usesTypes: false,
        fetch: async ({ api }) => {
            const people = new Map<string, { displayName: string; id: string | null; teams: string[] }>();

            for (const roster of await api.getTeamRosters()) {
                for (const identity of roster.members) {
                    const key = identity.uniqueName || identity.displayName;
                    const known = people.get(key);

                    if (known) {
                        known.teams.push(roster.team);
                        continue;
                    }

                    people.set(key, {
                        displayName: identity.displayName,
                        id: identity.id ?? null,
                        teams: [roster.team],
                    });
                }
            }

            for (const person of people.values()) {
                person.teams.sort();
            }

            return { people: sortedRecord([...people.entries()]) };
        },
    },
    {
        kind: "tags",
        exportName: "AdoTags",
        description: "Every tag defined in the project",
        usesTypes: false,
        fetch: async ({ api }) => ({ tags: (await api.getTags()).sort() }),
    },
];

export const MANIFEST_KIND_NAMES = MANIFEST_KINDS.map((kind) => kind.kind);

export function manifestKind(name: string): ManifestKind | undefined {
    return MANIFEST_KINDS.find((kind) => kind.kind === name);
}

/** A file written before manifests had kinds is a field manifest. */
export function kindOfManifest(manifest: AdoManifest): ManifestKind | undefined {
    return manifestKind(manifest.meta.kind ?? "fields");
}

export function diffOfKind(
    kind: ManifestKind,
    saved: AdoManifest & Record<string, unknown>,
    live: AdoManifest & Record<string, unknown>
): string[] {
    logger.debug({ kind: kind.kind }, "maintenance: diffing a manifest");
    return kind.diff ? kind.diff(saved, live) : diffManifestData(saved, live);
}

/** A readable listing for any manifest: one heading per record level, one line per value. */
export function renderGenericMd(manifest: AdoManifest & Record<string, unknown>): string {
    const { meta } = manifest;
    const lines = [
        `# ${meta.kind ?? "fields"}: ${meta.project}`,
        "",
        `Organization ${meta.org}, process ${meta.process ?? "unknown"}, fetched ${meta.fetchedAt}.`,
        `Regenerate with \`${meta.regenerate}\`.`,
    ];

    const show = (value: unknown): string => {
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
            return value.join(", ");
        }

        return typeof value === "string" ? value : SafeJSON.stringify(value);
    };

    const walk = (value: Record<string, unknown>, depth: number): void => {
        for (const [key, child] of Object.entries(value)) {
            const heading = ["", `${"#".repeat(Math.min(depth, 6))} ${key}`, ""];

            if (isRecord(child) && Object.values(child).some(isRecord)) {
                lines.push(...heading);
                walk(child, depth + 1);
            } else if (isRecord(child)) {
                lines.push(...heading, ...Object.entries(child).map(([name, item]) => `- ${name}: ${show(item)}`));
            } else if (Array.isArray(child) && depth === 2) {
                lines.push(...heading, ...child.map((item) => `- ${show(item)}`));
            } else {
                lines.push(`- ${key}: ${show(child)}`);
            }
        }
    };

    const { meta: _meta, ...payload } = manifest;
    walk(payload, 2);
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}
