import { emptyState, type AliasState, STATE_FILE, storage } from "@app/aliases/lib/analysis";
import { out } from "@app/logger";
import type { Command } from "commander";

async function resetAction(): Promise<void> {
    await storage.atomicUpdate<AliasState>(STATE_FILE, () => emptyState());
    out.log.success("Cleared alias-level state.");
}

export function registerResetCommand(program: Command): void {
    program.command("reset").description("Clear the persisted alias-level state").action(resetAction);
}
