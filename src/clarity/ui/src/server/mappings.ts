import { getConfig, saveConfig } from "../../../config";
import type { ClarityMapping } from "../../../config";

export async function getMappings(): Promise<{ mappings: ClarityMapping[]; configured: boolean }> {
    const config = await getConfig();

    if (!config) {
        return { mappings: [], configured: false };
    }

    return { mappings: config.mappings, configured: true };
}

export async function addMapping(data: Record<string, unknown>): Promise<{ success: boolean }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    const mapping: ClarityMapping = {
        clarityTaskId: data.clarityTaskId as number,
        clarityTaskName: data.clarityTaskName as string,
        clarityTaskCode: data.clarityTaskCode as string,
        clarityInvestmentName: data.clarityInvestmentName as string,
        clarityInvestmentCode: data.clarityInvestmentCode as string,
        adoWorkItemId: data.adoWorkItemId as number,
        adoWorkItemTitle: data.adoWorkItemTitle as string,
        adoWorkItemType: data.adoWorkItemType as string | undefined,
    };

    const existing = config.mappings.findIndex((m) => m.adoWorkItemId === mapping.adoWorkItemId);

    if (existing >= 0) {
        config.mappings[existing] = mapping;
    } else {
        config.mappings.push(mapping);
    }

    await saveConfig(config);
    return { success: true };
}

export async function removeMapping(adoWorkItemId: number): Promise<{ success: boolean }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    config.mappings = config.mappings.filter((m) => m.adoWorkItemId !== adoWorkItemId);
    await saveConfig(config);
    return { success: true };
}
