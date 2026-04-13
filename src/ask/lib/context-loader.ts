import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { CONFIG_FILENAME, loadContextConfig } from "@app/indexer/lib/context-artifacts";
import logger from "@app/logger";
import { limitToTokens } from "@app/utils/tokens";

/**
 * Walk up from `start` until `.genesistoolscontext.json` is found or we hit
 * the filesystem root. Returns the directory containing the config, or null.
 */
function findContextRoot(start: string): string | null {
    let current = resolve(start);

    while (current && current !== dirname(current)) {
        if (existsSync(resolve(current, CONFIG_FILENAME))) {
            return current;
        }

        current = dirname(current);
    }

    return null;
}

/**
 * Auto-discover the nearest .genesistoolscontext.json, read each artifact
 * file, and assemble a token-budgeted markdown block suitable for appending
 * to an LLM system prompt. Returns undefined when no config is found or all
 * artifact files are unreadable.
 */
export async function loadAskContext(cwd: string, budgetTokens: number): Promise<string | undefined> {
    const projectRoot = findContextRoot(cwd);

    if (!projectRoot) {
        return undefined;
    }

    let config: Awaited<ReturnType<typeof loadContextConfig>>;

    try {
        config = await loadContextConfig(projectRoot);
    } catch (err) {
        logger.debug(
            `[ask:context] failed to parse ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`
        );
        return undefined;
    }

    if (!config?.artifacts?.length) {
        return undefined;
    }

    const perArtifactBudget = Math.max(200, Math.floor(budgetTokens / config.artifacts.length));
    const sections: string[] = [];

    for (const artifact of config.artifacts) {
        const absPath = isAbsolute(artifact.path) ? artifact.path : resolve(projectRoot, artifact.path);

        if (!existsSync(absPath)) {
            continue;
        }

        let raw: string;

        try {
            raw = readFileSync(absPath, "utf-8");
        } catch (err) {
            logger.debug(`[ask:context] unreadable ${absPath}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }

        const { text, truncated } = limitToTokens(raw, perArtifactBudget);
        const suffix = truncated ? "\n…(truncated)" : "";
        sections.push(`## ${artifact.name} — ${artifact.description}\n\n${text}${suffix}`);
    }

    if (sections.length === 0) {
        return undefined;
    }

    return `# Project context (${CONFIG_FILENAME})\n\n${sections.join("\n\n")}`;
}
