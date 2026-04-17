import { genericView } from "./generic-view";
import type { ViewFn } from "./types";

const registry: Record<string, ViewFn> = {};

export function viewForAnalyzer(id: string): ViewFn {
    return registry[id] ?? genericView;
}
