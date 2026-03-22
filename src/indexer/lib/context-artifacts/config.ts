import fsp from "node:fs/promises";
import path from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { ContextArtifact, ContextConfig } from "./types";

export const CONFIG_FILENAME = ".genesistoolscontext.json";

/**
 * Load and validate .genesistoolscontext.json from a project root.
 * Returns null if the file doesn't exist. Throws on parse/validation errors.
 */
export async function loadContextConfig(projectPath: string): Promise<ContextConfig | null> {
    const configPath = path.join(path.resolve(projectPath), CONFIG_FILENAME);

    try {
        await fsp.access(configPath);
    } catch {
        return null;
    }

    const raw = await fsp.readFile(configPath, "utf-8");
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(raw, { strict: true });
    } catch (err) {
        throw new Error(
            `${CONFIG_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${CONFIG_FILENAME} must be a JSON object`);
    }

    const config = parsed as Record<string, unknown>;

    if (config.artifacts !== undefined) {
        validateArtifacts(config.artifacts);
    }

    return config as ContextConfig;
}

function validateArtifacts(artifacts: unknown): asserts artifacts is ContextArtifact[] {
    if (!Array.isArray(artifacts)) {
        throw new Error(`${CONFIG_FILENAME}: "artifacts" must be an array`);
    }

    const names = new Set<string>();

    for (let i = 0; i < artifacts.length; i++) {
        const a = artifacts[i];

        if (typeof a !== "object" || a === null || Array.isArray(a)) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}] must be an object`);
        }

        const artifact = a as Record<string, unknown>;

        if (typeof artifact.name !== "string" || !artifact.name.trim()) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}].name must be a non-empty string`);
        }

        if (typeof artifact.path !== "string" || !artifact.path.trim()) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}].path must be a non-empty string`);
        }

        if (typeof artifact.description !== "string" || !artifact.description.trim()) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}].description must be a non-empty string`);
        }

        const normalized = artifact.name.trim().toLowerCase();

        if (names.has(normalized)) {
            throw new Error(`${CONFIG_FILENAME}: duplicate artifact name "${artifact.name}"`);
        }

        names.add(normalized);
    }
}
