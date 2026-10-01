import { createTransclusionRegistry, type TransclusionRegistry } from "../registry";
import type { TransclusionDefinition } from "../types";
import { cmdTransclusion } from "./cmd";
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

/** A fresh registry with the built-in kinds; callers may `define` more on it. */
export function defaultTransclusionRegistry(): TransclusionRegistry {
    return createTransclusionRegistry([...DEFAULT_TRANSCLUSIONS]);
}

export {
    cmdTransclusion,
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
