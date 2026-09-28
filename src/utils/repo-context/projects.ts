import { posix } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { ancestorsOf, joinRelative } from "./gather";
import type { ContextGatherer, RepoContextReader } from "./types";

const { log } = logger.scoped("repo-context");

export type Ecosystem = "node" | "python" | "rust" | "go" | "php" | "ruby";
export type TestRunner =
    | "package-script"
    | "vitest"
    | "jest"
    | "mocha"
    | "bun"
    | "pytest"
    | "cargo"
    | "go"
    | "phpunit"
    | "pest"
    | "rspec";

interface EcosystemSpec {
    ecosystem: Ecosystem;
    /** Any of these marks a project directory; the first present one is reported as the manifest. */
    manifests: readonly string[];
    /** Looked up from the project directory up to the root: a workspace keeps one lockfile at its top. */
    lockfiles: ReadonlyArray<readonly [name: string, manager: string]>;
    defaultManager: string;
    extensions: RegExp;
}

/** One row per ecosystem. Adding one is a row here plus its branch in `describeProject`. */
export const ECOSYSTEMS: readonly EcosystemSpec[] = [
    {
        ecosystem: "node",
        manifests: ["package.json"],
        lockfiles: [
            ["bun.lock", "bun"],
            ["bun.lockb", "bun"],
            ["pnpm-lock.yaml", "pnpm"],
            ["yarn.lock", "yarn"],
            ["package-lock.json", "npm"],
        ],
        defaultManager: "npm",
        extensions: /\.(?:[cm]?[jt]s|[jt]sx|vue|svelte)$/,
    },
    {
        ecosystem: "python",
        manifests: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
        lockfiles: [
            ["uv.lock", "uv"],
            ["poetry.lock", "poetry"],
            ["Pipfile.lock", "pipenv"],
        ],
        defaultManager: "pip",
        extensions: /\.pyi?$/,
    },
    { ecosystem: "rust", manifests: ["Cargo.toml"], lockfiles: [], defaultManager: "cargo", extensions: /\.rs$/ },
    { ecosystem: "go", manifests: ["go.mod"], lockfiles: [], defaultManager: "go", extensions: /\.go$/ },
    { ecosystem: "php", manifests: ["composer.json"], lockfiles: [], defaultManager: "composer", extensions: /\.php$/ },
    { ecosystem: "ruby", manifests: ["Gemfile"], lockfiles: [], defaultManager: "bundler", extensions: /\.rb$/ },
];

export interface ProjectInfo {
    /** Directory holding the manifest, relative to the root; `.` for the root. */
    directory: string;
    manifest: string;
    ecosystem: Ecosystem;
    name?: string;
    packageManager: string;
    testRunner?: TestRunner;
    /** The `test` script of a node project, verbatim. */
    testScript?: string;
}

function readObject(text: string | undefined): Record<string, unknown> | undefined {
    if (!text) {
        return undefined;
    }

    try {
        const value: unknown = SafeJSON.parse(text, { strict: true });
        return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : undefined;
    } catch (error) {
        log.debug({ error }, "Manifest is not valid JSON");
        return undefined;
    }
}

function stringField(object: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = object?.[key];
    return typeof value === "string" ? value : undefined;
}

function objectField(object: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
    const value = object?.[key];
    return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : undefined;
}

function dependsOn(manifest: Record<string, unknown> | undefined, name: string): boolean {
    return ["dependencies", "devDependencies", "require", "require-dev"].some(
        (field) => objectField(manifest, field)?.[name] !== undefined
    );
}

/**
 * Finds the project that owns a path and what it runs on, reading only through the caller's reader.
 * Every answer is memoized per locator, and the reader is memoized per gather, so a hundred returned
 * files in one package read its `package.json` once.
 */
export function createProjectLocator(reader: RepoContextReader) {
    const byDirectory = new Map<string, Promise<ProjectInfo | undefined>>();

    async function lockfileManager(spec: EcosystemSpec, directory: string): Promise<string | undefined> {
        for (const ancestor of ancestorsOf(directory)) {
            for (const [name, manager] of spec.lockfiles) {
                if ((await reader.lookup(joinRelative(ancestor, name))) === "file") {
                    return manager;
                }
            }
        }

        return undefined;
    }

    async function describeProject(spec: EcosystemSpec, directory: string, manifest: string): Promise<ProjectInfo> {
        const text = await reader.readText(manifest);
        const base: ProjectInfo = {
            directory,
            manifest,
            ecosystem: spec.ecosystem,
            packageManager: (await lockfileManager(spec, directory)) ?? spec.defaultManager,
        };
        if (spec.ecosystem === "node") {
            const json = readObject(text);
            // `"packageManager": "pnpm@9.1.0"` is the project's own statement and outranks a lockfile.
            const declared = stringField(json, "packageManager")?.split("@")[0];
            const packageManager = declared || base.packageManager;
            const testScript = stringField(objectField(json, "scripts"), "test");
            const testRunner: TestRunner | undefined = testScript
                ? "package-script"
                : dependsOn(json, "vitest")
                  ? "vitest"
                  : dependsOn(json, "jest")
                    ? "jest"
                    : dependsOn(json, "mocha")
                      ? "mocha"
                      : packageManager === "bun"
                        ? "bun"
                        : undefined;
            return { ...base, name: stringField(json, "name"), packageManager, testRunner, testScript };
        }

        if (spec.ecosystem === "python") {
            return { ...base, testRunner: text?.includes("pytest") ? "pytest" : undefined };
        }

        if (spec.ecosystem === "php") {
            const json = readObject(text);
            const testRunner = dependsOn(json, "pestphp/pest")
                ? "pest"
                : dependsOn(json, "phpunit/phpunit")
                  ? "phpunit"
                  : undefined;
            return { ...base, name: stringField(json, "name"), testRunner };
        }

        if (spec.ecosystem === "ruby") {
            return { ...base, testRunner: text?.includes("rspec") ? "rspec" : undefined };
        }

        return { ...base, testRunner: spec.ecosystem === "rust" ? "cargo" : "go" };
    }

    /** The nearest project directory at or above `directory`; `specs` narrows which ecosystems count. */
    async function nearest(directory: string, specs: readonly EcosystemSpec[]): Promise<ProjectInfo | undefined> {
        for (const ancestor of ancestorsOf(directory)) {
            const key = `${specs.map((spec) => spec.ecosystem).join(",")}:${ancestor}`;
            let found = byDirectory.get(key);
            if (!found) {
                found = (async () => {
                    for (const spec of specs) {
                        for (const name of spec.manifests) {
                            const manifest = joinRelative(ancestor, name);
                            if ((await reader.lookup(manifest)) === "file") {
                                return describeProject(spec, ancestor, manifest);
                            }
                        }
                    }

                    return undefined;
                })();
                byDirectory.set(key, found);
            }

            const project = await found;
            if (project) {
                return project;
            }
        }

        return undefined;
    }

    return {
        /** A `.py` file belongs to the nearest Python project even when a `package.json` sits closer. */
        async projectFor(path: string): Promise<ProjectInfo | undefined> {
            const directory = posix.dirname(path);
            const own = ECOSYSTEMS.filter((spec) => spec.extensions.test(path));
            return own.length ? nearest(directory, own) : nearest(directory, ECOSYSTEMS);
        },
    };
}

export type ProjectLocator = ReturnType<typeof createProjectLocator>;

export interface OwnedProject extends ProjectInfo {
    /** Targets this project owns, in target order. */
    targets: string[];
}

/** The projects that own the targets, each with the targets it owns. Targets outside any project are left out. */
export function projectsGatherer(): ContextGatherer<"projects", OwnedProject[]> {
    return {
        id: "projects",
        async gather({ reader, targets }) {
            const locator = createProjectLocator(reader);
            const owned = new Map<string, OwnedProject>();
            for (const target of targets) {
                const project = await locator.projectFor(target.path);
                if (!project) {
                    continue;
                }

                const entry = owned.get(project.manifest) ?? { ...project, targets: [] };
                entry.targets.push(target.path);
                owned.set(project.manifest, entry);
            }

            return [...owned.values()];
        },
    };
}
