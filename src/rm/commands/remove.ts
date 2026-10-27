import { resolve } from "node:path";
import { out } from "@genesiscz/utils/logger";
import { planRemoval, presetsFor, scanPresets } from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { executePlan, minutesOption, runContext } from "../lib/run";

interface RemoveFlags {
    dryRun?: boolean;
    json?: boolean;
    reason?: string;
    keep?: number;
    now?: boolean;
    aside?: boolean;
}

function keepMinutes(flags: RemoveFlags): number | undefined {
    return flags.now ? 0 : flags.keep;
}

function addRemoveFlags(command: Command): Command {
    return command
        .option("-n, --dry-run", "show what each rule decides (and the sizes), move nothing")
        .option("--json", "print the result as JSON")
        .option("--reason <text>", "why, recorded with a request for the user")
        .option("--keep <duration>", "how long the trash keeps it before the drain (30m, 2h, 1d)", minutesOption)
        .option("--now", "no grace period: drain at once")
        .option("--aside", "move what needs the user aside, into this session's rm-aside folder, until they decide")
        .option("--no-aside", "leave what needs the user where it is");
}

export function registerRemoveCommand(program: Command): void {
    addRemoveFlags(program)
        .argument("[paths...]", "files or folders to delete")
        .action(async (paths: string[], flags: RemoveFlags) => {
            if (paths.length === 0) {
                program.help();
                return;
            }

            const ctx = runContext();
            const plan = planRemoval(paths, ctx.rules);
            await executePlan(plan, ctx, { ...flags, keepMinutes: keepMinutes(flags) });
        });

    addRemoveFlags(
        program
            .command("preset")
            .description("find and delete the folders of one or more presets (see tools rm presets), or all")
            .argument("<ids...>", "preset ids, or all")
            .option("--in <dir>", "folder to search (default: the current folder)")
            .option("--depth <n>", "how many folder levels to search", (v) => Number.parseInt(v, 10), 8)
    ).action(async (ids: string[], flags: RemoveFlags & { in?: string; depth: number }) => {
        const ctx = runContext();
        const available = presetsFor(ctx.config);
        const chosen = ids.includes("all") ? available : available.filter((preset) => ids.includes(preset.id));
        const unknown = ids.filter((id) => id !== "all" && !available.some((preset) => preset.id === id));

        if (unknown.length > 0) {
            out.println(
                pc.red(`Unknown preset: ${unknown.join(", ")}. Known: ${available.map((p) => p.id).join(", ")}`)
            );
            process.exitCode = 1;
            return;
        }

        const root = resolve(ctx.cwd, flags.in ?? ".");
        const matches = scanPresets(root, chosen, flags.depth);

        if (matches.length === 0) {
            out.println(`No ${chosen.map((p) => p.id).join(", ")} folders under ${root}.`);
            return;
        }

        const plan = planRemoval(
            matches.map((match) => match.path),
            ctx.rules
        );
        await executePlan(plan, ctx, { ...flags, keepMinutes: keepMinutes(flags) });
    });
}
