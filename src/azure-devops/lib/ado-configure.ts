import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Api, AZURE_DEVOPS_RESOURCE_ID } from "@app/azure-devops/api";
import { azLoginSuggestionBlock, azNotOnPathMessage, isAzOnPath } from "@app/azure-devops/lib/az-cli.utils";
import type { AzureConfig, AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { extractTeamFromUrl, parseAzureDevOpsUrl } from "@app/azure-devops/url-parser";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync, isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { $ } from "bun";

export async function checkAzureCliLogin(): Promise<void> {
    if (!isAzOnPath()) {
        throw new Error(azNotOnPathMessage());
    }

    try {
        await $`az account show`.quiet();
    } catch (error) {
        throw new Error(`Azure CLI not logged in. Run:\n${azLoginSuggestionBlock()}`, { cause: error });
    }
}

/**
 * Values for `az devops configure --defaults`. The project goes in by ID, not by name: on Windows `az`
 * is `az.cmd` under "C:\Program Files\...", and cmd.exe breaks any argument containing a space there
 * ("'C:\Program' is not recognized ..."). Project names often have one; az accepts the ID.
 */
export function azDevopsDefaults(config: Pick<AzureConfig, "org" | "project" | "projectId">): {
    organization: string;
    project: string;
} {
    return { organization: config.org, project: config.projectId || config.project };
}

export async function buildAdoConfig(url: string): Promise<AzureConfig & { orgId: string }> {
    const { org, project } = parseAzureDevOpsUrl(url);
    const [projectId, orgId] = await Promise.all([Api.getProjectId(org, project), Api.getOrgId(org)]);
    const team = extractTeamFromUrl(url);
    const config: AzureConfig & { orgId: string } = {
        org,
        project,
        projectId,
        orgId,
        apiResource: AZURE_DEVOPS_RESOURCE_ID,
    };

    if (team) {
        config.team = team;
    }

    return config;
}

/**
 * Write the config, keeping settings the caller could not have supplied.
 *
 * This used to write `config` over the whole file. A URL only ever carries org,
 * project and (sometimes) team, so re-running `configure` with a plain project
 * URL silently dropped the configured `team` — and with it the `timelog` block,
 * which holds the Azure Functions key. That key exists nowhere else, so the
 * only recovery was to fetch it again by hand (PR #333 review t9).
 *
 * Project identity is still authoritative from the caller: switching projects
 * must not merge the previous project's ids into the new one.
 */
export interface SavedAdoConfig {
    path: string;
    /** What was actually written — the merge may retain a team the URL did not carry. */
    config: AzureConfigWithTimeLog;
}

export function saveAdoConfig(config: AzureConfig, configDir: string, fileName = "config.json"): SavedAdoConfig {
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }

    const configPath = join(configDir, fileName);
    const existing = readExistingConfig(configPath);

    // Supplemental settings are only meaningful within one project. `team` names
    // a team of THAT project and `timelog` points at its endpoint, so carrying
    // them across a switch leaves `iterations` / `sprint` querying a team the
    // new project does not have (PR #333 review t1, a defect introduced by the
    // fix for t9 — preserving everything was too broad).
    const sameProject = existing.org === config.org && existing.project === config.project;
    const merged = sameProject ? { ...existing, ...config } : { ...config };

    atomicWriteFileSync(configPath, SafeJSON.stringify(merged, null, 2));
    return { path: configPath, config: merged as AzureConfigWithTimeLog };
}

/**
 * Only a missing file starts fresh. A file that exists but does not parse is refused, never replaced:
 * it may be the only copy of `timelog.functionsKey`, and a fresh config would drop it for good.
 */
function readExistingConfig(configPath: string): Partial<AzureConfigWithTimeLog> {
    let text: string;

    try {
        text = readFileSync(configPath, "utf8");
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return {};
        }

        throw err;
    }

    let parsed: unknown;

    try {
        // Lenient on purpose. NO_TEAM_MESSAGE tells users to add "team" to this
        // file by hand, so it really does grow `//` comments and trailing commas.
        // Under { strict: true } those threw and the whole config — including
        // timelog.functionsKey — was overwritten (PR #333 review t13). SafeJSON
        // is a comment-json wrapper; leniency here is the point of using it.
        parsed = SafeJSON.parse(text);
    } catch (err) {
        throw new Error(
            `Azure DevOps config ${configPath} does not parse, so it was left untouched. Fix or move it, then configure again.`,
            { cause: err }
        );
    }

    if (!isJsonObject(parsed)) {
        throw new Error(
            `Azure DevOps config ${configPath} is not a JSON object, so it was left untouched. Fix or move it, then configure again.`
        );
    }

    return parsed as Partial<AzureConfigWithTimeLog>;
}
