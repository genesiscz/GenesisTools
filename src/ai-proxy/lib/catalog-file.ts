import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export interface ModelsCatalogFile {
    updatedAt: string;
    grokVersion?: string;
    accounts: Array<{
        accountName: string;
        provider: string;
        baseUrl: string;
        pickerModels: unknown[];
        probedModels: unknown[];
        upstreamEndpoints: unknown[];
    }>;
}

const CATALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../data/models-catalog.json");

export function catalogFilePath(): string {
    return CATALOG_PATH;
}

export function loadCatalogFile(): ModelsCatalogFile | null {
    if (!existsSync(CATALOG_PATH)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(CATALOG_PATH, "utf-8")) as ModelsCatalogFile;
    } catch (err) {
        logger.warn({ err, path: CATALOG_PATH }, "ai-proxy: failed to parse models catalog");
        return null;
    }
}
