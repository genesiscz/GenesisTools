import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const AZURE_DIR = ".claude/azure";
export const CONFIG_FLAG = "--config";
export const CONFIG_ENV_VAR = "AZURE_DEVOPS_CONFIG";

const CONFIG_FILE = `${AZURE_DIR}/config.json`;
const SEARCH_LEVELS = 4;

export type ConfigPathSource = "flag" | "env" | "search";

export interface ConfigPathHit {
    path: string;
    source: ConfigPathSource;
}

export interface ConfigPathInput {
    /** The value of --config. */
    flag?: string;
    /** The value of AZURE_DEVOPS_CONFIG. */
    envValue?: string;
    /** Where the upward search starts. */
    searchFrom: string;
    /** What a relative explicit path is resolved against. */
    cwd: string;
}

const SOURCE_LABEL: Record<ConfigPathSource, string> = {
    flag: CONFIG_FLAG,
    env: CONFIG_ENV_VAR,
    search: "the upward search",
};

export class ConfigPathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigPathError";
    }
}

export function configPathSourceLabel(source: ConfigPathSource): string {
    return SOURCE_LABEL[source];
}

/** The path --config names, then the one AZURE_DEVOPS_CONFIG names. The file is not checked. */
export function explicitConfigPath(input: Pick<ConfigPathInput, "flag" | "envValue" | "cwd">): ConfigPathHit | null {
    const flag = input.flag?.trim();

    if (flag) {
        return { path: resolve(input.cwd, flag), source: "flag" };
    }

    const fromEnv = input.envValue?.trim();

    if (fromEnv) {
        return { path: resolve(input.cwd, fromEnv), source: "env" };
    }

    return null;
}

/** `.claude/azure/config.json` in startDir or in one of the three folders above it. */
export function searchConfigPath(startDir: string): string | null {
    let currentDir = resolve(startDir);

    for (let level = 0; level < SEARCH_LEVELS; level++) {
        const configPath = join(currentDir, CONFIG_FILE);

        if (existsSync(configPath)) {
            return configPath;
        }

        const parentDir = dirname(currentDir);

        if (parentDir === currentDir) {
            break;
        }

        currentDir = parentDir;
    }

    return null;
}

/**
 * --config wins, then AZURE_DEVOPS_CONFIG, then the upward search. An explicit path that is not a readable
 * file throws a ConfigPathError: it never falls back to the search.
 */
export function resolveConfigPath(input: ConfigPathInput): ConfigPathHit | null {
    const explicit = explicitConfigPath(input);

    if (explicit) {
        assertReadableFile(explicit);

        return explicit;
    }

    const found = searchConfigPath(input.searchFrom);

    return found ? { path: found, source: "search" } : null;
}

/** The folder that holds tasks/ and wiki/: next to an explicit config, otherwise `.claude/azure` in cwd. */
export function azureDataDir(input: Pick<ConfigPathInput, "flag" | "envValue" | "cwd">): string {
    const explicit = explicitConfigPath(input);

    return explicit ? dirname(explicit.path) : join(input.cwd, AZURE_DIR);
}

function errorCode(error: unknown): string | undefined {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
        return error.code;
    }

    return undefined;
}

function assertReadableFile(hit: ConfigPathHit): void {
    const origin = `${hit.path} (from ${configPathSourceLabel(hit.source)})`;
    let isFile: boolean;

    try {
        isFile = statSync(hit.path).isFile();
    } catch (error) {
        const code = errorCode(error);

        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new ConfigPathError(
                `Azure DevOps config not found: ${origin}. Pass the path of an existing config.json, or leave the option out to search from the working directory.`
            );
        }

        throw new ConfigPathError(`Azure DevOps config cannot be read: ${origin}${code ? ` (${code})` : ""}.`);
    }

    if (!isFile) {
        throw new ConfigPathError(`Azure DevOps config is not a file: ${origin}. Pass the config.json file itself.`);
    }

    try {
        accessSync(hit.path, constants.R_OK);
    } catch (error) {
        const code = errorCode(error);

        throw new ConfigPathError(`Azure DevOps config cannot be read: ${origin}${code ? ` (${code})` : ""}.`);
    }
}
