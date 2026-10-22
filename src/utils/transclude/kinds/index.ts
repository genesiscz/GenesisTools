import { createTransclusionRegistry, type TransclusionRegistry } from "../registry";
import type { TransclusionDefinition, TransclusionHints } from "../types";
import { cmdTransclusion, createCmdTransclusion } from "./cmd";
import { diffTransclusion } from "./diff";
import { fileTransclusion } from "./file";
import { imageTransclusion } from "./image";
import { jsonTransclusion } from "./json";
import { linesTransclusion } from "./lines";
import { prThreadTransclusion } from "./pr-thread";
import { symbolTransclusion } from "./symbol";
import { tailTransclusion } from "./tail";
import { urlTransclusion } from "./url";

/** The built-in kinds, in help order. A new kind is one file here plus one line in this list. */
export const DEFAULT_TRANSCLUSIONS: readonly TransclusionDefinition[] = [
    linesTransclusion,
    fileTransclusion,
    symbolTransclusion,
    diffTransclusion,
    tailTransclusion,
    jsonTransclusion,
    cmdTransclusion,
    urlTransclusion,
    imageTransclusion,
    prThreadTransclusion,
];

/**
 * A fresh registry with the built-in kinds; callers may `define` more on it. `hints` name the caller's own commands
 * (see {@link TransclusionHints}); without them the registry names none.
 */
export function defaultTransclusionRegistry(hints: TransclusionHints = {}): TransclusionRegistry {
    const kinds = DEFAULT_TRANSCLUSIONS.map((kind) =>
        kind === cmdTransclusion && hints.cmdTools ? createCmdTransclusion(hints.cmdTools) : kind
    );
    return createTransclusionRegistry(kinds, hints);
}

export {
    cmdTransclusion,
    createCmdTransclusion,
    diffTransclusion,
    fileTransclusion,
    imageTransclusion,
    jsonTransclusion,
    linesTransclusion,
    prThreadTransclusion,
    symbolTransclusion,
    tailTransclusion,
    urlTransclusion,
};
