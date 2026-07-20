import {
    ANNOTATION_PRESETS,
    isPresetName,
    loadAnnotationPlanValue,
    renderAnnotationPlan,
} from "@genesiscz/utils/image";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

function defaultOutputPath(input: string): string {
    return input.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-annotated${ext || ".png"}`);
}

export function registerDrawCommand(program: Command): void {
    program
        .command("draw <image>")
        .description(
            'Draw annotations onto an existing image from a JSON plan — highlight (rounded-rect outline), box, ellipse, arrow, label, blur (redact), crop (applied last), grid (coordinate finder).\nCoordinates are NATURAL IMAGE PIXELS. Works on any capture source (playwright, peekaboo, screencapture) — annotation is post-processing.\nPlan: {annotations: [{kind: "highlight", rect: {x,y,w,h}, label: {text: "…"}}], preset?} or a bare annotations array.'
        )
        .requiredOption("--annotate <json-or-path>", "inline JSON (starts with { or [) or a path to plan.json")
        .option("--out <path>", "output path (default <input>-annotated.png, or the plan's output field)")
        .option("--in-place", "overwrite the input image (the original is NEVER mutated without this)")
        .option(
            "--preset <name>",
            `style preset: ${Object.keys(ANNOTATION_PRESETS).join(" | ")} (overrides the plan's preset)`
        )
        .option("--json", "machine-readable result JSON on stdout")
        .action(
            async (
                image: string,
                opts: { annotate: string; out?: string; inPlace?: boolean; preset?: string; json?: boolean }
            ) => {
                if (opts.inPlace && opts.out) {
                    logger.error("--in-place and --out are mutually exclusive");
                    process.exit(1);
                }

                if (opts.preset !== undefined && !isPresetName(opts.preset)) {
                    logger.error(
                        `unknown preset "${opts.preset}" — valid: ${Object.keys(ANNOTATION_PRESETS).join(", ")}`
                    );
                    process.exit(1);
                }

                if (!(await Bun.file(image).exists())) {
                    logger.error(`image not found: ${image}`);
                    process.exit(1);
                }

                try {
                    const plan = await loadAnnotationPlanValue(opts.annotate);
                    const preset = opts.preset && isPresetName(opts.preset) ? opts.preset : plan.preset;
                    const result = await renderAnnotationPlan({ input: image, annotations: plan.annotations, preset });
                    const output = opts.inPlace ? image : (opts.out ?? plan.output ?? defaultOutputPath(image));
                    await Bun.write(output, result.png);

                    if (opts.json) {
                        out.result({
                            ok: true,
                            input: image,
                            output,
                            width: result.width,
                            height: result.height,
                            annotations: plan.annotations.length,
                            warnings: result.warnings,
                        });
                        return;
                    }

                    for (const warning of result.warnings) {
                        out.println(pc.yellow(`warning: ${warning}`));
                    }

                    out.println(
                        `${pc.green("annotated")} ${plan.annotations.length} annotation(s) ${result.width}x${result.height} -> ${pc.dim(output)}`
                    );
                } catch (error) {
                    logger.error(error instanceof Error ? error.message : String(error));
                    process.exit(1);
                }
            }
        );
}
