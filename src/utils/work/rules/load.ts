/**
 * Loads the rules of one project. Lenient like the repository loader: a broken or newer file gives the defaults and
 * a problem, never a throw. A read never writes; `setWorkConfigValue` is the one writer, through a locked document.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadRepoConfig } from "@genesiscz/utils/git/repo-config";
import { logger } from "@genesiscz/utils/logger";
import { type Diagnostic, warningDiagnostic } from "@genesiscz/utils/output/reply";
import { type DocumentUpdate, jsonDocument, prettyJson } from "@genesiscz/utils/storage/locked-document";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import type { Item } from "../model/item";
import { ITEM_TYPES, type ItemType } from "../model/vocab";
import {
    migrateWorkConfig,
    NOTIFY_ACTIONS,
    NOTIFY_SURFACES,
    type NotifyAction,
    type NotifyLevel,
    type NotifyRule,
    REPO_WORK_VERSION,
    type RepoWorkSection,
    repoWorkSectionSchema,
    WORK_CONFIG_VERSION,
    type WorkConfigFile,
    workConfigFileSchema,
} from "./config";
import { type NotifyLayerInput, type ResolvedRules, type RuleLayerInput, resolveWorkRules } from "./resolve";

const log = logger.child({ component: "work:rules" });

export function workConfigPath(): string {
    return genesisToolsDir("work", "config.json");
}

const EMPTY_FILE: WorkConfigFile = { version: WORK_CONFIG_VERSION };

type Decoded<T> = { value: T; problems: Diagnostic[] };

function decodeWith<T>(
    raw: unknown,
    where: string,
    parse: (
        value: unknown
    ) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
    empty: T,
    version = WORK_CONFIG_VERSION
): Decoded<T> {
    const migrated = migrateWorkConfig(raw, undefined, version);

    if (!migrated.ok) {
        const message =
            "newer" in migrated
                ? `${where} has version ${migrated.newer}, newer than this code (${version}); the built-in rules apply.`
                : `${where}: ${migrated.problem}; the built-in rules apply.`;
        return { value: empty, problems: [warningDiagnostic("CONFIG_UNUSABLE", message)] };
    }

    const parsed = parse(migrated.raw);

    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
            .join("; ");
        return {
            value: empty,
            problems: [
                warningDiagnostic(
                    "CONFIG_UNUSABLE",
                    `${where} does not fit its shape (${detail}); the built-in rules apply.`
                ),
            ],
        };
    }

    return { value: parsed.data, problems: [] };
}

function machineDocument(path = workConfigPath(), onUnreadable: "preserve" | "refuse" = "preserve") {
    return jsonDocument<unknown>({
        path,
        empty: () => EMPTY_FILE,
        decode: (raw) => raw,
        onUnreadable,
    });
}

export function readWorkConfig(path = workConfigPath()): Decoded<WorkConfigFile> {
    let raw: unknown;

    try {
        raw = machineDocument(path).read();
    } catch (error) {
        log.warn({ err: error, path }, "work rules: the machine file is unreadable");
        return {
            value: EMPTY_FILE,
            problems: [warningDiagnostic("CONFIG_UNUSABLE", `${path} is unreadable; the built-in rules apply.`)],
        };
    }

    return decodeWith(raw, path, (v) => workConfigFileSchema.safeParse(v), EMPTY_FILE);
}

export interface LoadedRules {
    project: string;
    rules: ResolvedRules;
    notifyLayers: NotifyLayerInput[];
    problems: Diagnostic[];
    /** Where each layer came from, for `config --explain`. */
    sources: { layer: NotifyLayerInput["layer"]; path: string | null }[];
}

export interface ProjectLocation {
    project: string;
    repoRoot?: string | null;
}

export type LoadProjectRules = (location: ProjectLocation) => Promise<LoadedRules>;

function existingCheckout(root: string | null | undefined): root is string {
    return Boolean(root && isAbsolute(root) && existsSync(join(root, ".git")));
}

/** A work call can reuse its checkout for its own project and its rule reads across consumers. */
export function projectRuleLoader(caller: ProjectLocation & { configPath?: string }): LoadProjectRules {
    const cache = new Map<string, { root?: string | null; loaded: Promise<LoadedRules> }>();
    return ({ project, repoRoot }) => {
        const root = project === caller.project ? (caller.repoRoot ?? repoRoot) : repoRoot;
        const cached = cache.get(project);

        if (cached && (!root || cached.root === root)) {
            return cached.loaded;
        }

        const loaded = loadWorkRules({ project, repoRoot: root, configPath: caller.configPath });
        cache.set(project, { root, loaded });
        return loaded;
    };
}

/** Finish loading before delivery starts. An item's creator can supply a checkout only for its own project. */
export async function loadRulesForItems<T extends { item: Item }>(batch: readonly T[], load: LoadProjectRules) {
    // A loop, not Map.groupBy: the dev-dashboard UI program compiles this file against lib ES2023.
    const groups = new Map<string, T[]>();
    for (const entry of batch) {
        const group = groups.get(entry.item.project);
        if (group) {
            group.push(entry);
        } else {
            groups.set(entry.item.project, [entry]);
        }
    }

    const projects = Array.from(groups, async ([project, entries]) => {
        const creator = entries.find(
            ({ item }) => item.createdBy.project === project && existingCheckout(item.createdBy.repoRoot)
        );
        const loaded = await load({ project, repoRoot: creator?.item.createdBy.repoRoot });
        return [project, { entries, loaded }] as const;
    });
    return new Map(await Promise.all(projects));
}

/** Every layer for one project. `repoRoot` is the checkout whose `genesis-tools.config.json` holds the repo layer. */
export async function loadWorkRules({
    project,
    repoRoot,
    configPath = workConfigPath(),
}: ProjectLocation & { configPath?: string }): Promise<LoadedRules> {
    const machine = readWorkConfig(configPath);
    const own = machine.value.projects?.[project];
    const problems = [...machine.problems];
    const layers: RuleLayerInput[] = [];
    const sources: LoadedRules["sources"] = [];

    if (machine.value.global?.rules !== undefined) {
        layers.push({ layer: "config.global", rules: machine.value.global.rules });
        sources.push({ layer: "config.global", path: configPath });
    }

    const root = repoRoot ?? own?.roots?.find(existingCheckout);

    if (root) {
        const repo = await loadRepoConfig(root);
        const section = repo.config.work;

        if (section !== undefined) {
            const decoded: Decoded<RepoWorkSection | null> = decodeWith(
                section,
                `${repo.path ?? "the repository config"} (section work)`,
                (v) => repoWorkSectionSchema.safeParse(v),
                null,
                REPO_WORK_VERSION
            );
            problems.push(...decoded.problems);

            if (decoded.value?.rules !== undefined) {
                layers.push({ layer: "config.repo", rules: decoded.value.rules });
                sources.push({ layer: "config.repo", path: repo.path });
            }
        }
    }

    if (own?.rules !== undefined) {
        layers.push({ layer: "config.project", rules: own.rules });
        sources.push({ layer: "config.project", path: configPath });
    }

    const notifyLayers: NotifyLayerInput[] = [...layers];

    for (const surface of NOTIFY_SURFACES) {
        const rules = own?.surfaces?.[surface];
        const layer = `surface.${surface}` as const;
        notifyLayers.push({ layer, rules: rules ?? {} });

        if (rules !== undefined) {
            sources.push({ layer, path: configPath });
        }
    }

    return { project, rules: resolveWorkRules(layers), notifyLayers, problems, sources };
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
    let node = target;

    for (const key of path.slice(0, -1)) {
        const next = Object.hasOwn(node, key) ? node[key] : undefined;

        if (!Object.hasOwn(node, key) || typeof next !== "object" || next === null || Array.isArray(next)) {
            Object.defineProperty(node, key, { value: {}, enumerable: true, writable: true, configurable: true });
        }

        node = node[key] as Record<string, unknown>;
    }

    const last = path[path.length - 1];

    if (value === undefined) {
        delete node[last];
    } else {
        node[last] = value;
    }
}

export type SetResult = { ok: true; file: WorkConfigFile } | { ok: false; problem: string };

/**
 * Sets one value of the machine file by a dotted path (`projects.App.rules.types.bug.fields.where`), under the
 * file's lock. The result must still fit the shape, or nothing is written.
 */
export async function setWorkConfigValue({
    path,
    value,
    configPath = workConfigPath(),
}: {
    path: string;
    value: unknown;
    configPath?: string;
}): Promise<SetResult> {
    const keys = path.split(".");

    if (keys.some((key) => !key || key === "__proto__" || key === "constructor" || key === "prototype")) {
        return { ok: false, problem: "Invalid configuration path." };
    }

    return machineDocument(configPath).update((current): DocumentUpdate<unknown, SetResult> => {
        const migrated = migrateWorkConfig(current ?? EMPTY_FILE);

        if (!migrated.ok) {
            return {
                keep: {
                    ok: false as const,
                    problem:
                        "newer" in migrated ? `the file has the newer version ${migrated.newer}` : migrated.problem,
                },
            };
        }

        const next = structuredClone(migrated.raw);
        setPath(next, keys, value);
        const parsed = workConfigFileSchema.safeParse(next);

        if (!parsed.success) {
            const detail = parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");
            return { keep: { ok: false, problem: `the value does not fit the shape: ${detail}` } };
        }

        if (value !== undefined) {
            let found: unknown = parsed.data;

            for (const key of keys) {
                if (typeof found !== "object" || found === null || !Object.hasOwn(found, key)) {
                    return { keep: { ok: false, problem: `Unknown configuration path: ${path}.` } };
                }

                found = Reflect.get(found, key);
            }
        }

        return { write: parsed.data, result: { ok: true, file: parsed.data } };
    });
}

export { prettyJson };

export interface NotifyEdit {
    type: ItemType | "*";
    action: NotifyAction | "*";
    level: NotifyLevel | null;
}

type RawCell = NotifyRule | null;
export interface NotifyConfigChange {
    path: string;
    type: ItemType;
    action: NotifyAction;
    from: RawCell;
    to: RawCell;
}

export type NotifyConfigSetResult =
    | { ok: true; file: string; changed: NotifyConfigChange[] }
    | { ok: false; code: string; problem: string };

interface NotifyConfigWrite {
    scope: "project" | "global";
    project?: string;
    projectExists?: boolean;
    configPath?: string;
    notify?: NotifyEdit;
    restore?: Omit<NotifyConfigChange, "path">[];
    lockedCells?: ReadonlySet<string>;
    dryRun?: boolean;
}

function sameRule(a: RawCell, b: RawCell): boolean {
    return (
        a === b ||
        (a !== null &&
            b !== null &&
            typeof a === "object" &&
            typeof b === "object" &&
            a.level === b.level &&
            a.minSeverity === b.minSeverity)
    );
}

function selectedCells(edit: NotifyEdit) {
    const types = edit.type === "*" ? ITEM_TYPES : [edit.type];
    const actions = edit.action === "*" ? NOTIFY_ACTIONS : [edit.action];
    return types.flatMap((type) => actions.map((action) => ({ type, action })));
}

/** Read, compare and edit every selected cell under the same lock. An Undo is conditional on the saved values. */
export async function setWorkNotifyConfig(options: NotifyConfigWrite): Promise<NotifyConfigSetResult> {
    const { scope, project, notify, restore, lockedCells, configPath = workConfigPath() } = options;
    const refuse = (code: string, problem: string): NotifyConfigSetResult => ({ ok: false, code, problem });
    if (scope === "project" && !project?.trim()) {
        return refuse("PROJECT_REQUIRED", "Choose a project for this rule.");
    }
    if (notify?.type === "*" && notify.action === "*") {
        return refuse("TOO_WIDE", "Choose one type or one action.");
    }
    if (
        restore?.length &&
        !restore.every((cell) => cell.type === restore[0].type) &&
        !restore.every((cell) => cell.action === restore[0].action)
    ) {
        return refuse("TOO_WIDE", "Undo one row or column at a time.");
    }
    if ((notify && restore) || (!notify && !restore?.length)) {
        return refuse("INVALID_EDIT", "Choose one notification change or a set of changes to undo.");
    }
    const file = machineDocument(configPath, "refuse");
    const edit = (raw: unknown): DocumentUpdate<unknown, NotifyConfigSetResult> => {
        const migrated = migrateWorkConfig(raw);
        if (!migrated.ok) {
            return {
                keep: refuse(
                    "CONFIG_UNUSABLE",
                    "newer" in migrated ? "This config uses a newer version." : migrated.problem
                ),
            };
        }
        const parsed = workConfigFileSchema.safeParse(migrated.raw);
        if (!parsed.success) {
            return { keep: refuse("CONFIG_UNUSABLE", "The current rules do not fit the config format.") };
        }
        const config = parsed.data;
        if (scope === "project" && !options.projectExists && !Object.hasOwn(config.projects ?? {}, project!)) {
            return { keep: refuse("UNKNOWN_PROJECT", "This project has no saved rules or work items.") };
        }
        const base = scope === "global" ? ["global", "rules", "notify"] : ["projects", project!, "rules", "notify"];
        const rules = scope === "global" ? config.global?.rules : config.projects?.[project!]?.rules;
        const updates = notify
            ? selectedCells(notify).map((cell) => ({ ...cell, edit: notify, previous: null }))
            : (restore ?? []).map((previous) => ({
                  type: previous.type,
                  action: previous.action,
                  edit: null,
                  previous,
              }));
        const changed: NotifyConfigChange[] = [];
        const seen = new Set<string>();
        for (const { type, action, edit, previous } of updates) {
            const key = `${type}:${action}`;
            if (seen.has(key)) {
                return { keep: refuse("INVALID_EDIT", "A rule appears twice in this change.") };
            }
            seen.add(key);
            // Undoing a removal may now reveal a repository rule. Restore the machine override that
            // the receipt removed, provided no newer machine override replaced it.
            if (!previous && lockedCells?.has(key)) {
                if (updates.length > 1) {
                    continue;
                }
                return { keep: refuse("REPO_RULE_LOCKED", "Change this rule in the repository’s file.") };
            }
            const before = rules?.notify?.[type]?.[action] ?? null;
            let desired: RawCell;
            if (previous) {
                if (!sameRule(before, previous.to)) {
                    return { keep: refuse("RULE_CHANGED", "Another writer changed a rule. Read the rules again.") };
                }
                desired = previous.from;
            } else {
                desired =
                    edit.level !== null && before !== null && typeof before === "object"
                        ? { ...before, level: edit.level }
                        : edit.level;
            }
            if (sameRule(before, desired)) {
                continue;
            }
            const segments = [...base, type, action];
            setPath(migrated.raw, segments, desired ?? undefined);
            changed.push({ path: segments.join("."), type, action, from: before, to: desired });
        }
        const result: NotifyConfigSetResult = { ok: true, changed, file: configPath };
        return changed.length && !options.dryRun ? { write: migrated.raw, result } : { keep: result };
    };
    if (options.dryRun) {
        const preview = edit(file.read());
        return "keep" in preview ? preview.keep : preview.result;
    }
    return file.update(edit);
}
