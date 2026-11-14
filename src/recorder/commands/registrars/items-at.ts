import { Movie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("items-at")
        .description(
            "What plays at an OUTPUT time of the edit, in words: the source time, the picture and canvas zooms, hidden parts, texts, shapes, lenses, the caption line and what is said"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .argument("<at>", 'output seconds or "m:ss"')
        .action(async (value: string, at: string) => {
            try {
                const answer = await new Movie(value).itemsAt(/^\d+(\.\d+)?$/.test(at) ? Number(at) : at);

                for (const warning of answer.warnings ?? []) {
                    out.printlnErr(warning);
                }

                const zoomWords = (label: string, view: typeof answer.zoom) => {
                    if (!view) {
                        return undefined;
                    }

                    return "glide" in view
                        ? `${label} glide ${view.glide.from.id} to ${view.glide.to.id}`
                        : `${label} ${view.scale}× (${view.id})`;
                };
                const seen = [
                    zoomWords("zoom", answer.zoom),
                    zoomWords("canvas zoom", answer.canvasZoom),
                    ...answer.redactions.map(
                        (part) => `${part.style === "spotlight" ? "spotlight" : "hidden part"} ${part.id}`
                    ),
                    ...answer.texts.map((note) => `text "${note.text}" (${note.id})`),
                    ...answer.shapes.map((shape) => `${shape.kind} ${shape.id}`),
                    ...answer.lenses.map((lens) => `lens ${lens.id}`),
                    answer.caption ? `caption "${answer.caption}"` : undefined,
                    answer.spoken && !answer.caption ? `said "${answer.spoken}" (captions off)` : undefined,
                ].filter(Boolean);
                out.printlnErr(
                    `at ${answer.output} s (source ${answer.source} s): ${seen.length ? seen.join(", ") : "nothing over the picture"}`
                );

                out.result(answer);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
