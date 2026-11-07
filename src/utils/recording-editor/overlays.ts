import { z } from "zod";
import type { EditProject } from "./project";

/** project.ts's `hexColor`, written again: project.ts imports this file, so a value import back would be a cycle. */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a color is #RRGGBB");

/**
 * Round 4 overlays drawn over the export (and the preview): animated captions and texts (feature 6), the progress bar
 * with its chapter strip (10), and the intro and end cards (9). The renderer (Render/Overlays.swift) draws them; this
 * file holds their shapes and the ops' rules.
 */

// R4 6 animated captions and texts
/** "line" shows the whole line at once (today's look); "karaoke" colours each word as it is said. */
export const CAPTION_KINDS = ["line", "karaoke"] as const;

/** How the captions animate; absent is "line". */
export const captionsStyleSchema = z.object({
    kind: z.enum(CAPTION_KINDS).default("karaoke"),
    /** The colour of the words said so far. */
    color: hexColor.default("#FFD60A"),
});
export type EditCaptionsStyle = z.infer<typeof captionsStyleSchema>;

/** How a text comes in: "fade" (absent means this), "typewriter" (letter by letter), "slideUp" (rises and fades in). */
export const TEXT_ANIMATIONS = ["fade", "typewriter", "slideUp"] as const;

export const textAnimateSchema = z.object({
    kind: z.enum(TEXT_ANIMATIONS),
    /** How long the way in takes. */
    ms: z.number().int().min(100).max(5000).default(600),
});
export type EditTextAnimate = z.infer<typeof textAnimateSchema>;

export function applyCaptionsStyle(
    project: EditProject,
    op: { kind?: (typeof CAPTION_KINDS)[number]; color?: string; enabled?: boolean }
): EditProject {
    if (op.enabled === false) {
        const { captionsStyle: _style, ...rest } = project;
        return rest;
    }

    const { enabled: _enabled, ...change } = op;
    const captionsStyle = captionsStyleSchema.parse({
        ...project.captionsStyle,
        ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
    });
    return { ...project, captionsStyle };
}

/** A text's `animate` as an op gives it: "fade" with no length is the default, so the key goes. */
export function textAnimateOf(
    animate: { kind: (typeof TEXT_ANIMATIONS)[number]; ms?: number } | undefined
): EditTextAnimate | undefined {
    if (!animate || (animate.kind === "fade" && animate.ms === undefined)) {
        return undefined;
    }

    return textAnimateSchema.parse(animate);
}
