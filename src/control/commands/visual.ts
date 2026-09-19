import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { NativeVisualDriver, visualTask } from "../lib/decision/visual";
import { type ControlOptions, lazyEvaluator, observationOptions, withSigintAbort } from "./decision";

export function registerVisualCommand(program: Command) {
    observationOptions(
        program.command("visual").description("Native OCR choice with immutable screenshot evidence; no model download")
    )
        .requiredOption("--intent <text>", "Observed text or visual target description")
        .option("--chooser [mode]", "exact, jev or auto; Jev is the only AI model", "exact")
        .option("--window-index <n>", "Select a native window index for this capture")
        .option("--crop <x,y,w,h>", "OCR crop in source screenshot pixels")
        .option("--width <pixels>", "OCR input width after crop, 64–8192")
        .option("--click", "Explicitly dispatch one validated click on the chosen OCR region", false)
        .option("--background", "Window-addressed click without explicit activation or pointer movement")
        .action(
            async (
                options: ControlOptions & {
                    intent: string;
                    chooser: string | boolean;
                    click: boolean;
                    background?: boolean;
                    windowIndex?: string;
                    crop?: string;
                    width?: string;
                }
            ) => {
                const mode = z.enum(["exact", "jev", "auto"]).safeParse(options.chooser);
                if (!mode.success) {
                    out.log.error(suggestEnumFlag("tools control visual", "--chooser", ["exact", "jev", "auto"]));
                    process.exitCode = 1;
                    return;
                }
                const driver = new NativeVisualDriver({
                    app: z.string().min(1).parse(options.app),
                    scope: z.enum(["window", "chrome"]).parse(options.scope),
                    windowId: options.windowId
                        ? z.number().int().positive().parse(Number(options.windowId))
                        : undefined,
                    windowIndex:
                        options.windowIndex === undefined
                            ? undefined
                            : z.number().int().nonnegative().parse(Number(options.windowIndex)),
                    crop: options.crop,
                    width: options.width ? z.number().int().min(64).max(8192).parse(Number(options.width)) : undefined,
                    background: options.background,
                });
                await withSigintAbort(async (signal) => {
                    const result = await visualTask({
                        intent: options.intent,
                        chooser: mode.data,
                        execute: options.click,
                        driver,
                        signal,
                        limits: { timeoutMs: Math.min(30000, Number(options.timeout)) },
                        evaluate: mode.data === "exact" ? undefined : lazyEvaluator(program),
                    });
                    out.result(result);
                    if (result.choice.status !== "resolved" || (options.click && !result.action?.ok)) {
                        process.exitCode = 1;
                    }
                });
            }
        );
}
