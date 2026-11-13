import { isAbsolute, resolve } from "node:path";
import type { Annotation, PresetName } from "@genesiscz/utils/image";
import { ANNOTATION_PRESETS, renderAnnotationPlan, validateAnnotations } from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";

export interface AnnotateImageArgs {
    input: string;
    annotations: Annotation[];
    output?: string;
    preset?: PresetName;
}

export async function handleAnnotateImage(args: AnnotateImageArgs): Promise<string> {
    if (typeof args.input !== "string" || args.input.length === 0) {
        throw new Error('input is required — the absolute path of the image to annotate, e.g. "/path/to/shot.png"');
    }

    if (!isAbsolute(args.input)) {
        throw new Error(`input must be an absolute path, got "${args.input}"`);
    }

    if (!(await Bun.file(args.input).exists())) {
        throw new Error(`image not found: ${args.input} (pass an absolute path on this machine)`);
    }

    validateAnnotations(args.annotations);
    const result = await renderAnnotationPlan({
        input: args.input,
        annotations: args.annotations,
        preset: args.preset,
    });
    const output = args.output ?? args.input.replace(/(\.[a-z0-9]+)?$/i, "-annotated.png");

    if (resolve(output) === resolve(args.input)) {
        throw new Error(`output must not equal input: ${output} (this tool never mutates the original)`);
    }

    await Bun.write(output, result.png);

    return SafeJSON.stringify({
        ok: true,
        output,
        width: result.width,
        height: result.height,
        annotations: args.annotations.length,
        warnings: result.warnings,
    });
}

export const ANNOTATE_IMAGE_INPUT_SCHEMA = {
    type: "object",
    properties: {
        input: {
            type: "string",
            description: "absolute path of the image to annotate (PNG/JPEG) — the original is never mutated",
        },
        annotations: {
            type: "array",
            description:
                'annotation objects, drawn in array order; coordinates are natural image pixels. Kinds: highlight {rect:{x,y,w,h}, style?, preset?, label?:{text,position?,offset?:{x,y},leader?}} (rounded-rect outline + translucent wash — the review register), box (square corners), ellipse, arrow {from:{x,y}, to:{x,y}}, label {at:{x,y}, text} (chip), blur {rect, strength?} (redact secrets), crop {rect} (applied LAST regardless of position), grid {step?, originOffset?:{x,y}, labels?} (coordinate-finder gridlines labeled with absolute coords). Label positions: top-left (default), top-right, top, bottom-left, bottom-right, bottom, left, right (with a leader line), inside; "\\n" breaks a label into lines; a label that would leave the image or cover an earlier label moves to the next free position. A shape\'s own preset overrides the plan\'s. Example: [{ "kind": "highlight", "rect": { "x": 748, "y": 812, "w": 1246, "h": 430 }, "label": { "text": "Build pipeline" } }]',
            items: { type: "object" },
        },
        output: {
            type: "string",
            description: "output path for the annotated copy (default: <input>-annotated.png next to the input)",
        },
        preset: {
            type: "string",
            enum: Object.keys(ANNOTATION_PRESETS),
            description:
                "style defaults per kind: review-red = thick red rounded outline + wash (default), callout-amber, redact = blackout fill + heavy blur, review-dashed and callout-amber-dashed = thin dashed outline with small chips (web shots), info-blue, ok-green, question-purple, muted-gray (context). Per-annotation preset and style values override the plan preset",
        },
    },
    required: ["input", "annotations"],
} as const;
