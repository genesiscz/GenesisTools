// Re-export from canonical location for backward compat
export type { AIAccountEntry, AIAccountTokens, AIProvider } from "@app/utils/config/ai.types";

// Keep AIAccountConfig for any remaining callers
export interface AIAccountConfig {
    accounts: import("@app/utils/config/ai.types").AIAccountEntry[];
    defaultAccount?: string;
}
