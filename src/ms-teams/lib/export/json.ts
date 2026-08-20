import { SafeJSON } from "@genesiscz/utils/json";
import type { ThreadExport } from "../types";

export function renderJson(thread: ThreadExport): string {
    return `${SafeJSON.stringify(thread, null, 2)}\n`;
}
