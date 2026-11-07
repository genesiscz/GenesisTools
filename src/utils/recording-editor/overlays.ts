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

// R4 10 progress bar and chapter strip
/**
 * R6 8: where a chapter's name shows. "auto" (the default) puts it in the frame's free area (the padding, or the free
 * side of a phone preset), never over the movie; without a frame it sits at the bottom left above the bar. The four
 * corners are the canvas's corners ("topLeft" was the place before round 6).
 */
export const CHAPTER_PLACES = ["auto", "topLeft", "topRight", "bottomLeft", "bottomRight"] as const;
export type ChapterPlace = (typeof CHAPTER_PLACES)[number];

/**
 * A thin bar along the bottom of the export showing the share played, divided at the markers (the recording's and
 * the edit's), and the name of each chapter for `chapterMs` when it starts. `height` is a share of the canvas's short
 * side.
 */
export const progressSchema = z.object({
    show: z.boolean().default(true),
    color: hexColor.default("#FFFFFF"),
    height: z.number().min(0.002).max(0.03).default(0.008),
    chapters: z.boolean().default(true),
    chapterMs: z.number().int().min(500).max(10_000).default(2000),
    // R6 8 chapter label place
    /** Where a chapter's name shows; absent is "auto". */
    chapterPlace: z.enum(CHAPTER_PLACES).optional(),
});
export type EditProgress = z.infer<typeof progressSchema>;

export function applyProgress(
    project: EditProject,
    op: {
        show?: boolean;
        color?: string;
        height?: number;
        chapters?: boolean;
        chapterMs?: number;
        chapterPlace?: ChapterPlace;
        enabled?: boolean;
    }
): EditProject {
    if (op.enabled === false) {
        const { progress: _progress, ...rest } = project;
        return rest;
    }

    const { enabled: _enabled, ...change } = op;
    const progress = progressSchema.parse({
        ...project.progress,
        ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
    });
    return { ...project, progress };
}

// R4 9 intro and end cards
/** A title card before the movie: title, subtitle, a logo picture and a date, on the frame's background. */
export const introCardSchema = z.object({
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().max(200).optional(),
    /** A picture file (png, jpg, heic), absolute. */
    logo: z.string().optional(),
    /** Any text ("7 November 2026"). */
    date: z.string().max(60).optional(),
    seconds: z.number().min(0.5).max(15).default(3),
});

/** A card after the movie: a line of text, a link and, with `qr`, a QR code of the link. */
export const endCardSchema = z.object({
    text: z.string().trim().min(1).max(200),
    link: z.string().max(300).optional(),
    qr: z.boolean().default(false),
    seconds: z.number().min(0.5).max(15).default(3),
});

/**
 * The cards around the movie. The export (`tools recorder export`, the window's Export, movie.export()) plays the
 * intro before the first frame and the end card after the last; the preview and output times stay the movie's own.
 */
export const cardsSchema = z.object({
    intro: introCardSchema.optional(),
    end: endCardSchema.optional(),
});
export type EditCards = z.infer<typeof cardsSchema>;

const PICTURE_EXTENSIONS = ["png", "jpg", "jpeg", "heic", "tiff", "gif", "webp"];

/** `introCard` and `endCard` ops: a change merges into the card; `enabled: false` removes that card. */
export function applyCard(
    project: EditProject,
    which: "intro" | "end",
    change: Record<string, unknown> & { enabled?: boolean },
    files: { exists: (path: string) => boolean; resolve: (path: string) => string }
): EditProject {
    const { enabled, ...fields } = change;
    const current = project.cards ?? {};
    let next: EditCards;

    if (enabled === false) {
        const { [which]: _gone, ...rest } = current;
        next = rest;
    } else {
        // An empty text removes that field ("" for subtitle, logo, date or link), as the editor window sends it.
        const merged: Record<string, unknown> = Object.fromEntries(
            Object.entries({
                ...current[which],
                ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
            }).filter(([, value]) => value !== "")
        );

        if (which === "intro") {
            const logo = typeof merged.logo === "string" && merged.logo ? files.resolve(merged.logo) : undefined;

            if (logo) {
                const extension = logo.split(".").pop()?.toLowerCase() ?? "";

                if (!files.exists(logo)) {
                    throw new Error(`the logo ${logo} does not exist`);
                }

                if (!PICTURE_EXTENSIONS.includes(extension)) {
                    throw new Error(`a logo is a picture (${PICTURE_EXTENSIONS.join(", ")}), not ${logo}`);
                }
            }

            const { logo: _logo, ...rest } = merged;

            if (!rest.title) {
                throw new Error("the intro card needs a title the first time");
            }

            next = { ...current, intro: introCardSchema.parse({ ...rest, ...(logo ? { logo } : {}) }) };
        } else {
            if (!merged.text) {
                throw new Error("the end card needs a text the first time");
            }

            if (merged.qr === true && !merged.link) {
                throw new Error("a QR code needs a link");
            }

            next = { ...current, end: endCardSchema.parse(merged) };
        }
    }

    if (!next.intro && !next.end) {
        const { cards: _cards, ...rest } = project;
        return rest;
    }

    return { ...project, cards: next };
}

/** How long the export plays before the movie's first frame (the intro card), in microseconds. */
export function cardsLeadUs(project: EditProject): number {
    return Math.round((project.cards?.intro?.seconds ?? 0) * 1_000_000);
}
