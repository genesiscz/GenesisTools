import { chmod } from "node:fs/promises";
import { Storage } from "@app/utils/storage/storage";
import { z } from "zod";

const MappingSchema = z.object({
    clarityTaskId: z.number(),
    clarityTaskName: z.string(),
    clarityTaskCode: z.string(),
    clarityInvestmentName: z.string(),
    clarityInvestmentCode: z.string(),
    clarityTimesheetId: z.number().optional(),
    clarityTimeEntryId: z.number().optional(),
    adoWorkItemId: z.number(),
    adoWorkItemTitle: z.string(),
    adoWorkItemType: z.string().optional(),
});

const ClarityConfigSchema = z.object({
    baseUrl: z.string().url(),
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

export async function getConfig(): Promise<ClarityConfig | null> {
    const raw = await storage.getConfig<ClarityConfig>();

    if (!raw) {
        return null;
    }

    const result = ClarityConfigSchema.safeParse(raw);
    return result.success ? result.data : null;
}

export async function saveConfig(config: ClarityConfig): Promise<void> {
    ClarityConfigSchema.parse(config);
    await storage.ensureDirs();
    await storage.setConfig(config);
    await chmod(storage.getConfigPath(), 0o600);
}

export async function requireConfig(): Promise<ClarityConfig> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured. Run: tools clarity configure");
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
