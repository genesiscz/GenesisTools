/**
 * Loads the rules of one project. Lenient like the repository loader: a broken or newer file gives the defaults and
 * a problem, never a throw. A read never writes; `setWorkConfigValue` is the one writer, through a locked document.
 */
import { loadRepoConfig } from "@genesiscz/utils/git/repo-config";
import { logger } from "@genesiscz/utils/logger";
import { type Diagnostic, warningDiagnostic } from "@genesiscz/utils/output/reply";
import { type DocumentUpdate, jsonDocument, prettyJson } from "@genesiscz/utils/storage/locked-document";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import {
    migrateWorkConfig,
    type RepoWorkSection,
    repoWorkSectionSchema,
    WORK_CONFIG_VERSION,
    type WorkConfigFile,
    workConfigFileSchema,
} from "./config";
import { type ResolvedRules, type RuleLayerInput, resolveRules } from "./resolve";

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
    empty: T
): Decoded<T> {
    const migrated = migrateWorkConfig(raw);

    if (!migrated.ok) {
        const message =
            "newer" in migrated
                ? `${where} has version ${migrated.newer}, newer than this code (${WORK_CONFIG_VERSION}); the built-in rules apply.`
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

function machineDocument(path = workConfigPath()) {
    return jsonDocument<unknown>({
        path,
        empty: () => EMPTY_FILE,
        decode: (raw) => raw,
        onUnreadable: "preserve",
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
    problems: Diagnostic[];
    /** Where each layer came from, for `config --explain`. */
    sources: { layer: RuleLayerInput["layer"]; path: string | null }[];
}

/** Every layer for one project. `repoRoot` is the checkout whose `genesis-tools.config.json` holds the repo layer. */
export async function loadWorkRules({
    project,
    repoRoot,
    configPath = workConfigPath(),
}: {
    project: string;
    repoRoot?: string | null;
    configPath?: string;
}): Promise<LoadedRules> {
    const machine = readWorkConfig(configPath);
    const problems = [...machine.problems];
    const layers: RuleLayerInput[] = [];
    const sources: LoadedRules["sources"] = [];

    if (machine.value.global?.rules !== undefined) {
        layers.push({ layer: "config.global", rules: machine.value.global.rules });
        sources.push({ layer: "config.global", path: configPath });
    }

    if (repoRoot) {
        const repo = await loadRepoConfig(repoRoot);
        const section = repo.config.work;

        if (section !== undefined) {
            const decoded: Decoded<RepoWorkSection | null> = decodeWith(
                section,
                `${repo.path ?? "the repository config"} (section work)`,
                (v) => repoWorkSectionSchema.safeParse(v),
                null
            );
            problems.push(...decoded.problems);

            if (decoded.value?.rules !== undefined) {
                layers.push({ layer: "config.repo", rules: decoded.value.rules });
                sources.push({ layer: "config.repo", path: repo.path });
            }
        }
    }

    const own = machine.value.projects?.[project]?.rules;

    if (own !== undefined) {
        layers.push({ layer: "config.project", rules: own });
        sources.push({ layer: "config.project", path: configPath });
    }

    return { project, rules: resolveRules(layers), problems, sources };
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
    let node = target;

    for (const key of path.slice(0, -1)) {
        const next = node[key];

        if (typeof next !== "object" || next === null || Array.isArray(next)) {
            node[key] = {};
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
        setPath(
            next,
            path.split(".").filter((p) => p.length > 0),
            value
        );
        const parsed = workConfigFileSchema.safeParse(next);

        if (!parsed.success) {
            const detail = parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");
            return { keep: { ok: false, problem: `the value does not fit the shape: ${detail}` } };
        }

        return { write: parsed.data, result: { ok: true, file: parsed.data } };
    });
}

export { prettyJson };
