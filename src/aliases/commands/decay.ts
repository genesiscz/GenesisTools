import { updateMyelination } from "@app/aliases/lib/core";
import { type DecayFlags, daysSince, emptyState, type MyelinState, STATE_FILE, storage } from "@app/aliases/lib/myelin";
import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";

async function decayAction(flags: DecayFlags): Promise<void> {
    const now = Date.now();
    let decayed = 0;
    let pruned = 0;

    const next = await storage.atomicUpdate<MyelinState>(STATE_FILE, (current) => {
        const state: MyelinState = current?.paths ? current : emptyState();
        const result = emptyState();

        for (const [key, path] of Object.entries(state.paths)) {
            const level = updateMyelination({
                level: path.level,
                reused: false,
                daysSince: daysSince(path.lastSeen, now),
            });
            decayed += 1;

            if (level <= 0) {
                pruned += 1;
                continue;
            }

            result.paths[key] = {
                ...path,
                level: Math.round(level * 100) / 100,
            };
        }

        return result;
    });

    if (flags.json) {
        out.result(SafeJSON.stringify({ decayed, pruned, paths: next.paths }, null, 2));
        return;
    }

    out.result(`Decay pass complete: ${decayed} path(s) aged, ${pruned} pruned (level 0).`);
}

export function registerDecayCommand(program: Command): void {
    program
        .command("decay")
        .description("Age out unused paths: apply per-day decay, drop dead paths")
        .option("--json", "Emit the post-decay state as JSON")
        .action(decayAction);
}
