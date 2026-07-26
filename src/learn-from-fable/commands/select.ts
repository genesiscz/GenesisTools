import { out } from "@genesiscz/utils/logger";
import type { FableConfig } from "../lib/config";
import { listCandidates, loadMinedState, unminedCandidates } from "../lib/enumerate";

export interface SelectOptions {
    limit: number;
    minSize: number;
    json?: boolean;
}

/** Machine-readable selection: unmined session paths, oldest first. */
export async function selectCommand(config: FableConfig, options: SelectOptions): Promise<void> {
    const candidates = await listCandidates(config, { minSize: options.minSize });
    const mined = loadMinedState(config);
    const unmined = unminedCandidates(candidates, mined).slice(0, options.limit);

    if (options.json) {
        out.result(unmined);
        return;
    }

    for (const c of unmined) {
        out.print(`${c.path}\n`);
    }
}
