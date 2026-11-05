/**
 * The optional parts of GenesisTools.app (Martin, 2026-10-18: "make it a bit generic so we can pick more parts of the
 * native app to not build"). The host (launcher, `--rpc`, permission faces, vault approval, notifications, microphone,
 * link router, settings window) is always built; a part is built only when a build asks for it.
 *
 * The Swift side of this table is `src/macos/GenesisTools/Package.swift` (one target per part, linked when
 * `GENESIS_APP_PARTS` names it) and `Sources/Host/AppFaces+Declared.swift`, which face-table.ts writes from the faces
 * declared here (which part serves each face, whether it is a window, its name in the ⌘Q question). A new part is one
 * row here, one target there, and one block in `Sources/GenesisTools/Parts.swift`. A new face is one entry in its
 * part's `faces`, then `bun scripts/native/app-faces.ts --write` (a build writes it too).
 *
 * Which parts a build makes (Martin's D15 a): the parts already installed; the host alone on a fresh install. A face
 * launcher (`tools hub`) adds its part when the installed app lacks it.
 */

import { logger } from "@genesiscz/utils/logger";

/** A bundle step that only some parts need; the host build skips all of them. */
export type AppBundleStep = "diff-viewer" | "markdown-webview" | "clicky-library";

/**
 * One face of the app: a first argument that starts a long-lived process of the bundle (`GenesisTools --meetings`).
 * This declaration is the only list of faces. The host reads it from `Sources/Host/AppFaces+Declared.swift`, which
 * `renderSwiftFaceTable` (face-table.ts) writes from it, and the rebuild's relaunch reads it here (relaunch.ts).
 */
export interface AppFace {
    /** The first argument that starts it. */
    flag: string;
    /** Older names that start the same face; every table answers for them as for `flag`. */
    aliases?: readonly string[];
    /**
     * A window the person sees: it writes its exact argv at launch (Host/App/FaceRecord.swift), starts a link relay in
     * front of itself (Host/LinkRelay.swift) and logs its lifecycle. False for a face with no window of its own.
     */
    window: boolean;
    /** A rebuild reopens it, under this name in the build output (relaunch.ts). Absent: it stays closed after a rebuild. */
    reopen?: string;
    /** The ⌘Q question names it while its process runs (Host/PartQuit), the lowest `order` first. Absent: never named. */
    quit?: { name: string; order: number };
}

export interface AppPart {
    id: string;
    /** The `GenesisTools <flag>` faces this part serves. */
    faces: readonly AppFace[];
    bundleSteps: readonly AppBundleStep[];
    /** Parts a build with this one makes too (Package.swift `requires`); never a code dependency. */
    requires?: readonly string[];
    summary: string;
}

const PARTS = [
    {
        id: "features",
        // `--clicky` is the face's old name, from the time Clicky owned the window: relaunch records and scripts.
        faces: [
            {
                flag: "--features",
                aliases: ["--clicky"],
                window: true,
                reopen: "features",
                quit: { name: "Settings", order: 20 },
            },
        ],
        bundleSteps: [],
        summary: "the feature settings window, where the other parts add their pages (staging)",
    },
    // The hub, the widget and Clicky have pages in the feature settings window, so a build with one makes it too.
    {
        id: "hub",
        faces: [
            { flag: "--hub", window: true, reopen: "hub", quit: { name: "Hub", order: 30 } },
            { flag: "--review", window: true, reopen: "review", quit: { name: "Review", order: 40 } },
        ],
        bundleSteps: ["diff-viewer", "markdown-webview"],
        requires: ["features"],
        summary: "the hub and the diff review window",
    },
    {
        id: "widget",
        faces: [{ flag: "--widget", window: true, reopen: "widget", quit: { name: "Widget", order: 10 } }],
        bundleSteps: [],
        requires: ["features"],
        summary: "the agent widget (staging)",
    },
    {
        id: "clicky",
        // No face of its own: Clicky's status item runs in the feature settings process.
        faces: [],
        bundleSteps: ["clicky-library"],
        requires: ["features"],
        summary: "Clicky, the keyboard sounds (staging)",
    },
    {
        id: "markdown",
        // A rebuild leaves the viewer closed: it does not come back on the file it showed.
        faces: [{ flag: "--markdown", window: true, quit: { name: "Markdown viewer", order: 50 } }],
        bundleSteps: ["markdown-webview"],
        summary: "the markdown viewer",
    },
    {
        id: "recorder",
        // A menu bar item and the live recordings' controls, no window: the quit question never names it, and a
        // rebuild brings the item back.
        faces: [{ flag: "--recorder", window: false, reopen: "recorder" }],
        bundleSteps: [],
        // Settings → Recorder lives in the feature settings window.
        requires: ["features"],
        summary: "the screen recorder: its menu bar item, the live recordings' controls and the recording editor",
    },
    {
        id: "meetings",
        faces: [{ flag: "--meetings", window: true, reopen: "meetings", quit: { name: "Meetings", order: 60 } }],
        bundleSteps: [],
        requires: ["features"],
        summary: "the Meetings window and the Meetings settings pages",
    },
] as const satisfies readonly AppPart[];

/**
 * The host's own window, which no part serves: the permissions window. A bare launch (Finder, `open -a`) and macOS's
 * `-psn_…` argument start it too.
 */
export const HOST_WINDOW_FACE = {
    flag: "--window",
    window: true,
    reopen: "settings",
    quit: { name: "Permissions", order: 100 },
} as const satisfies AppFace;

export const APP_PARTS: readonly AppPart[] = PARTS;

export const ALL_PART_IDS: readonly string[] = APP_PARTS.map((part) => part.id);

type ReopenOf<Face> = Face extends { reopen: infer Kind } ? Kind : never;

/** The names a rebuild reopens a face under: every `reopen` of the declarations. */
export type WindowFaceKind = ReopenOf<(typeof PARTS)[number]["faces"][number]> | ReopenOf<typeof HOST_WINDOW_FACE>;

/** A face with the part that serves it; `part` is undefined for the host's own window. */
export interface DeclaredFace extends Omit<AppFace, "reopen"> {
    reopen?: WindowFaceKind;
    part: string | undefined;
}

function declareFaces(): DeclaredFace[] {
    const faces: DeclaredFace[] = [];

    for (const part of PARTS) {
        for (const face of part.faces) {
            faces.push({ ...face, part: part.id });
        }
    }

    faces.push({ ...HOST_WINDOW_FACE, part: undefined });
    return faces;
}

/** Every face: each part's faces in the order of `APP_PARTS`, then the host's own window. */
export const APP_FACES: readonly DeclaredFace[] = declareFaces();

/** The face a flag or an alias starts. */
export function appFace(flag: string): DeclaredFace | undefined {
    return APP_FACES.find((face) => face.flag === flag || face.aliases?.includes(flag));
}

/** The face a launch's first argument starts: a bare launch and `-psn_…` are the host's own window. */
export function faceOfFirstArgument(first: string): DeclaredFace | undefined {
    return appFace(first === "" || first.startsWith("-psn_") ? HOST_WINDOW_FACE.flag : first);
}

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

    if (!manifest.parts) {
        return [...ALL_PART_IDS].sort();
    }

    // The manifest may come from a build of another checkout with a part this one does not know: keep the known ones
    // instead of throwing, which would stop `appStatus()` and every later build. A `--parts` value stays strict.
    const known = manifest.parts.map((id) => id.trim()).filter((id) => ALL_PART_IDS.includes(id));
    const unknown = manifest.parts.map((id) => id.trim()).filter((id) => id && !ALL_PART_IDS.includes(id));

    if (unknown.length > 0) {
        logger.warn({ unknown }, "app parts: the installed manifest names parts this checkout does not know; ignored");
    }

    return normalizeParts(known);
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
    return appFace(flag)?.part;
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

    // Every other word is checked first, so `all,nope` is refused like `hub,nope` instead of building everything.
    const parts = normalizeParts(words.filter((word) => word !== "host" && word !== "all"));

    if (words.includes("all")) {
        return [...ALL_PART_IDS].sort();
    }

    return parts;
}

export function bundleStepsFor(parts: readonly string[]): Set<AppBundleStep> {
    return new Set(APP_PARTS.filter((part) => parts.includes(part.id)).flatMap((part) => part.bundleSteps));
}
