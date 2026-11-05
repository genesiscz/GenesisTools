import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const log = logger.child({ component: "e2e.project" });

/**
 * The project file `tools e2e` reads: which runner runs the project's specs, where the specs and page objects are, and
 * the named suites. The tool owns the run (spec discovery, one runner process per spec, the run folder, the summary);
 * the project owns its specs, page objects, runner config and hooks. A project default-exports an `E2eProjectConfig`
 * from `e2e.config.ts`; paths in it are relative to the file.
 *
 * ```ts
 * import type { E2eProjectConfig } from "@genesiscz/utils/e2e/project";
 *
 * export default {
 *     id: "shop-web",
 *     runner: { kind: "playwright", config: "playwright.config.ts", baseUrl: "http://127.0.0.1:5173" },
 *     specs: { dir: "specs" },
 *     suites: { smoke: ["home", "checkout"] },
 * } satisfies E2eProjectConfig;
 * ```
 */
export interface E2eProjectConfig {
    /** A file-safe id; run folders carry it. */
    id: string;
    title?: string;
    /** The folder runner processes start in (the one whose node_modules has the runner), relative; default this file's. */
    cwd?: string;
    runner: E2eRunnerConfig;
    specs: {
        /** The spec folder, relative to this file. */
        dir: string;
        /** The glob under `dir` that names a spec file; default `**\/*.spec.ts`. */
        pattern?: string;
    };
    /** The page object folder, relative to this file; `tools e2e list` shows it. */
    pages?: string;
    /** Named spec sets (`tools e2e suite <name>`): spec names, the file name without `.spec.ts`. */
    suites?: Record<string, string[]>;
    hooks?: E2eHooks;
}

/** The runner kinds and the settings each one reads. One entry per kind; `RUNNERS` in the tool has one per key. */
export interface E2eRunnerSettings {
    /** WebdriverIO with Appium on an iOS simulator, through the project's own `wdio.conf.ts`. */
    wdio: {
        /** The WebdriverIO config, relative to this file. */
        config: string;
        /** The app's `mobile.config.ts`, relative to this file; default the nearest one at or above this file. */
        mobile?: string;
    };
    /** Playwright Test against a site, through the project's own `playwright.config.ts`. */
    playwright: {
        config: string;
        /** The site under test when `--base-url` is not given; the spec reads it as `E2E_BASE_URL`. */
        baseUrl?: string;
    };
}

export type E2eRunnerKind = keyof E2eRunnerSettings;

/** The `runner` entry of one kind: `{ kind: "wdio", config, mobile? }` or `{ kind: "playwright", config, baseUrl? }`. */
export type E2eRunnerOf<K extends E2eRunnerKind> = { kind: K } & E2eRunnerSettings[K];

export type E2eRunnerConfig<K extends E2eRunnerKind = E2eRunnerKind> = { [P in K]: E2eRunnerOf<P> }[K];

/** What a hook gets about the run. */
export interface E2eHookContext {
    runDir: string;
    specs: string[];
    /** The variables every spec process gets (`E2E_*`, plus `--env`). */
    environment: Record<string, string>;
}

/** The project's own steps around a run (seed a server, reset a fixture); a hook that throws stops the run. */
export interface E2eHooks {
    beforeRun?: (context: E2eHookContext) => void | Promise<void>;
    afterRun?: (context: E2eHookContext & { ok: boolean }) => void | Promise<void>;
}

const fn = <T>(label: string) =>
    z.custom<T>((value) => typeof value === "function", { message: `${label}: a function` });

const runnerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("wdio"), config: z.string().min(1), mobile: z.string().optional() }),
    z.object({ kind: z.literal("playwright"), config: z.string().min(1), baseUrl: z.string().url().optional() }),
]);

const configSchema: z.ZodType<E2eProjectConfig> = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "id: letters, digits, dot, dash or underscore"),
    title: z.string().optional(),
    cwd: z.string().optional(),
    runner: runnerSchema,
    specs: z.object({ dir: z.string().min(1), pattern: z.string().optional() }),
    pages: z.string().optional(),
    suites: z.record(z.string(), z.array(z.string())).optional(),
    hooks: z
        .object({
            beforeRun: fn<E2eHooks["beforeRun"]>("hooks.beforeRun").optional(),
            afterRun: fn<E2eHooks["afterRun"]>("hooks.afterRun").optional(),
        })
        .optional(),
});

/** The file names a project's e2e config may have, checked in each folder from the working folder up. */
export const E2E_CONFIG_FILES = ["e2e.config.ts", "e2e/e2e.config.ts"] as const;

export interface E2eProject {
    configPath: string;
    /** The folder the config file is in; every relative path in it resolves from here. */
    dir: string;
    /** The folder runner processes start in. */
    cwd: string;
    config: E2eProjectConfig;
}

/** The nearest e2e config at or above `cwd`; null when there is none up to the file system root. */
export function findE2eConfig(cwd: string): string | null {
    let dir = resolve(cwd);
    const { root } = parse(dir);

    while (true) {
        for (const name of E2E_CONFIG_FILES) {
            const candidate = join(dir, name);

            if (existsSync(candidate) && statSync(candidate).isFile()) {
                return candidate;
            }
        }

        if (dir === root) {
            return null;
        }

        dir = dirname(dir);
    }
}

export function parseE2eConfig(raw: unknown, source: string): E2eProjectConfig {
    const result = configSchema.safeParse(raw);

    if (!result.success) {
        throw new Error(`invalid e2e config ${source}:\n${z.prettifyError(result.error)}`);
    }

    return result.data;
}

/** Loads the e2e project: `--config`, else the nearest `e2e.config.ts` (or `e2e/e2e.config.ts`) at or above `cwd`. */
export async function loadE2eProject(options: { config?: string; cwd: string }): Promise<E2eProject> {
    const configPath = options.config
        ? isAbsolute(options.config)
            ? options.config
            : resolve(options.cwd, options.config)
        : findE2eConfig(options.cwd);

    if (!configPath) {
        throw new Error(
            `no ${E2E_CONFIG_FILES.join(" or ")} at or above ${options.cwd}; pass --config <file> or add one to the project`
        );
    }

    if (!existsSync(configPath)) {
        throw new Error(`the e2e config ${configPath} does not exist`);
    }

    const loaded = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
    const config = parseE2eConfig(loaded.default, configPath);
    const dir = dirname(configPath);
    log.debug({ configPath, id: config.id, runner: config.runner.kind }, "e2e project loaded");
    return { configPath, dir, cwd: resolve(dir, config.cwd ?? "."), config };
}
