import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { Storage } from "@genesiscz/utils/storage/storage";
import { z } from "zod";

const MappingSchema = z.object({
    clarityTaskId: z.number(),
    clarityTaskName: z.string(),
    clarityTaskCode: z.string(),
    clarityInvestmentName: z.string(),
    clarityInvestmentCode: z.string(),
    adoWorkItemId: z.number(),
    adoWorkItemTitle: z.string(),
    adoWorkItemType: z.string().optional(),
});

const ClarityConfigSchema = z.object({
    baseUrl: z.url(),
    authToken: z.string(),
    sessionId: z.string(),
    cookies: z.string().optional(),
    resourceId: z.number().optional(),
    uniqueName: z.string().optional(),
    mappings: z.array(MappingSchema).default([]),
});

export type ClarityMapping = z.infer<typeof MappingSchema>;
export type ClarityConfig = z.infer<typeof ClarityConfigSchema>;

const storage = new Storage("clarity");

/**
 * `null` means no config file: first-time setup. A file that does not parse (Storage throws) or does not
 * match the schema throws too, naming the path. Callers treat `null` as "start fresh with no mappings",
 * so returning it for a damaged file let the next save replace the user's mappings with `[]`.
 */
export async function getConfig(): Promise<ClarityConfig | null> {
    const raw = await storage.getConfig<ClarityConfig>();

    if (!raw) {
        return null;
    }

    const result = ClarityConfigSchema.safeParse(raw);

    if (!result.success) {
        const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
        throw new Error(
            `Clarity config ${storage.getConfigPath()} is not valid (${issues.join("; ")}), so it was left untouched. Fix or move it, then run ${toolCommand("clarity configure auth")}.`
        );
    }

    return result.data;
}

export async function saveConfig(config: ClarityConfig): Promise<void> {
    ClarityConfigSchema.parse(config);
    // Atomic, and 0600 from the temp file's birth: the file holds the auth token and session id.
    await storage.setConfig(config, { mode: process.platform === "win32" ? undefined : 0o600 });
}

export async function requireConfig(): Promise<ClarityConfig> {
    const config = await getConfig();

    if (!config) {
        throw new Error(`Clarity not configured. Run: ${toolCommand("clarity configure")}`);
    }

    return config;
}

export function getMappingForWorkItem(mappings: ClarityMapping[], workItemId: number): ClarityMapping | undefined {
    return mappings.find((m) => m.adoWorkItemId === workItemId);
}

export function getMappingForClarityTask(mappings: ClarityMapping[], taskId: number): ClarityMapping | undefined {
    return mappings.find((m) => m.clarityTaskId === taskId);
}

export { storage };
