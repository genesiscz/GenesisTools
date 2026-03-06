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
    await storage.ensureDirs();
    await storage.setConfig(config);
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

export function getMappingForClarityTask(mappings: ClarityMapping[], taskName: string): ClarityMapping | undefined {
    return mappings.find((m) => m.clarityTaskName === taskName);
}

export { storage };
