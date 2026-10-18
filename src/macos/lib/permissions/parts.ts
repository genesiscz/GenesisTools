/**
 * The optional parts of GenesisTools.app (request of 2026-10-18: "make it a bit generic so we can pick more parts of
 * the native app to not build"). The host (launcher, `--rpc`, permission faces, vault approval, notifications,
 * microphone, link router, settings window) is always built; a part is built only when a build asks for it.
 *
 * The Swift side of this table is `allParts` in `src/macos/GenesisTools/Package.swift`: the folders and files of each
 * part, excluded from the one app module when `GENESIS_APP_PARTS` does not name it. `Sources/App/MissingParts.swift`
 * stands in for the faces of a part that is not built. A new part is one row here, one row there, and one block in
 * MissingParts.swift.
 *
 * Which parts a build makes (decision D15 a): the parts already installed; the host alone on a fresh install. A face
 * launcher (`tools hub`) adds its part when the installed app lacks it.
 */

/** A bundle step that only some parts need; the host build skips all of them. */
export type AppBundleStep = "diff-viewer" | "markdown-webview" | "clicky-library";

export interface AppPart {
    id: string;
    /** The `GenesisTools <flag>` faces this part serves. */
    faces: readonly string[];
    bundleSteps: readonly AppBundleStep[];
    /** Other parts whose code this one calls: a build with this part builds them too (Package.swift `requires`). */
    requires?: readonly string[];
    summary: string;
}

export const APP_PARTS: readonly AppPart[] = [
    {
        id: "hub",
        faces: ["--hub", "--review"],
        bundleSteps: ["diff-viewer", "markdown-webview"],
        summary: "the hub and the diff review window",
    },
    { id: "widget", faces: ["--widget"], bundleSteps: [], summary: "the agent widget (staging)" },
    {
        id: "clicky",
        faces: ["--clicky"],
        bundleSteps: ["clicky-library"],
        // Its settings pages show the hub's notification rules and read through the hub's `tools` server.
        requires: ["hub"],
        summary: "Clicky and its settings (staging)",
    },
    { id: "markdown", faces: ["--markdown"], bundleSteps: ["markdown-webview"], summary: "the markdown viewer" },
];

export const ALL_PART_IDS: readonly string[] = APP_PARTS.map((part) => part.id);

/** Sorted, without duplicates; throws on an id that is not a part, naming the known ones. */
export function normalizeParts(ids: Iterable<string>): string[] {
    const unique = [...new Set([...ids].map((id) => id.trim()).filter(Boolean))];
    const unknown = unique.filter((id) => !ALL_PART_IDS.includes(id));

    if (unknown.length > 0) {
        throw new Error(`Unknown app part ${unknown.join(", ")}. Known parts: ${ALL_PART_IDS.join(", ")}.`);
    }

    return unique.sort();
}

/**
 * The parts an installed build has. A manifest written before parts existed (no `parts` field) is a full build;
 * no manifest at all is no install, so nothing is installed.
 */
export function installedParts(manifest: { parts?: readonly string[] } | undefined): string[] {
    if (!manifest) {
        return [];
    }

    return manifest.parts ? normalizeParts(manifest.parts) : [...ALL_PART_IDS].sort();
}

export interface PartsChoice {
    /** What the installed app has (`installedParts`). */
    installed: readonly string[];
    /** Parts to add on top (`--add-part`, a face launcher). */
    add?: readonly string[];
    /** Exactly these parts, ignoring what is installed (`--parts`). */
    exactly?: readonly string[];
}

/**
 * The parts a build makes: exactly the ones asked for, else the installed ones plus the added ones; either way with
 * the parts each of them requires.
 */
export function partsForBuild(choice: PartsChoice): string[] {
    const wanted = normalizeParts(choice.exactly ?? [...choice.installed, ...(choice.add ?? [])]);
    const required = wanted.flatMap((id) => APP_PARTS.find((part) => part.id === id)?.requires ?? []);
    return normalizeParts([...wanted, ...required]);
}

/** The part that serves a face flag (`--hub` → `hub`), or undefined for a host face. */
export function partForFace(flag: string): string | undefined {
    return APP_PARTS.find((part) => part.faces.includes(flag))?.id;
}

export function isFullBuild(parts: readonly string[]): boolean {
    return ALL_PART_IDS.every((id) => parts.includes(id));
}

/**
 * The SwiftPM scratch folder name for a parts set: `opt` for every part (the folder full builds always used), else
 * `opt-<ids>` (`opt-host` for none). Each set keeps its own incremental state, so switching never rebuilds the other.
 */
export function scratchName(parts: readonly string[]): string {
    if (isFullBuild(parts)) {
        return "opt";
    }

    return parts.length === 0 ? "opt-host" : `opt-${normalizeParts(parts).join("-")}`;
}

/** The `GENESIS_APP_PARTS` value Package.swift reads ("" = the host only). */
export function partsEnvValue(parts: readonly string[]): string {
    return normalizeParts(parts).join(",");
}

/** The values `--parts` accepts besides part ids: `host` (no part) and `all` (every part). */
export const PARTS_FLAG_VALUES: readonly string[] = ["host", "all", ...ALL_PART_IDS];

/** A `--parts` / `--add-part` value as part ids: comma-separated ids, `host` for none, `all` for every part. */
export function parsePartsFlag(value: string): string[] {
    const words = value
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean);

    if (words.includes("all")) {
        return [...ALL_PART_IDS].sort();
    }

    return normalizeParts(words.filter((word) => word !== "host"));
}

export function bundleStepsFor(parts: readonly string[]): Set<AppBundleStep> {
    return new Set(APP_PARTS.filter((part) => parts.includes(part.id)).flatMap((part) => part.bundleSteps));
}
