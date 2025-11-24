/**
 * CLI-specific types for the ask tool
 */

export type ModelsFormat = "table" | "json";

export type ModelsSortOrder = "price_input" | "input" | "price_output" | "output" | "name";

export interface ModelsOptions {
    provider?: string;
    format?: ModelsFormat;
    sort?: ModelsSortOrder;
    filterCapabilities?: string;
}
