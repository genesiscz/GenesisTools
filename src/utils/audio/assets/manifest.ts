import { join } from "node:path";

export const ASSETS_DIR = import.meta.dir;

/** Filenames present in this dir; keep in sync with CREDITS.md (CC0/PD only).
 *  Curated subset of Kenney "Interface Sounds" (CC0 1.0). `switch.wav` is the default. */
export const BUNDLED_SOUNDS = [
    "switch.wav",
    "confirm.wav",
    "confirm-soft.wav",
    "glass.wav",
    "glass-chime.wav",
    "pluck.wav",
    "question.wav",
    "select.wav",
    "open.wav",
    "close.wav",
    "error.wav",
    "drop.wav",
] as const;
export type BundledSound = (typeof BUNDLED_SOUNDS)[number];

export function bundledPath(name: BundledSound): string {
    return join(ASSETS_DIR, name);
}
