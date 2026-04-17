import { genericView } from "./generic-view";
import { processesView } from "./processes-view";
import type { ViewFn } from "./types";

const registry: Record<string, ViewFn> = {
    processes: processesView,
};

export function viewForAnalyzer(id: string): ViewFn {
    return registry[id] ?? genericView;
}
