import { readFile } from "node:fs/promises";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { applyLocalSourceAudio, planLocalSourceAudio } from "../lib/source-audio-backfill";
import { sourceAudioPlanSchema } from "../lib/source-audio-discovery";

export function registerAudioCommands(program: Command): void {
    const audio = program.command("audio").description("Permanent local source audio and explicit backfill");
    audio
        .command("plan")
        .description("Read-only reconciliation of provider, legacy and owned media; prints an apply plan as JSON")
        .action(async () => out.result(await planLocalSourceAudio()));
    audio
        .command("apply")
        .argument("<plan>", "JSON file produced by audio plan; revalidated before copying")
        .description("Explicitly preserve the reconciled files without modifying provider or legacy originals")
        .action(async (file: string) => {
            const plan = sourceAudioPlanSchema.parse(SafeJSON.parse(await readFile(file, "utf8")));
            out.result(await applyLocalSourceAudio({ plan }));
        });
}
