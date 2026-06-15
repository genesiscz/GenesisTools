import { emptyState, type MyelinState, STATE_FILE, storage } from "@app/aliases/lib/myelin";
import { out } from "@app/logger";
import type { Command } from "commander";

async function resetAction(): Promise<void> {
    await storage.atomicUpdate<MyelinState>(STATE_FILE, () => emptyState());
    out.log.success("Cleared myelination state.");
}

export function registerResetCommand(program: Command): void {
    program.command("reset").description("Clear the persisted myelination state").action(resetAction);
}
