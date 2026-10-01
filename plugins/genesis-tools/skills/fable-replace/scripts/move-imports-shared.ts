/**
 * fable-replace — what every language's `imports=fix` planner shares: the located move, the error
 * that names its spec line, warnings that carry a spec fix, and the repository's file list.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { identifierPattern } from "./internal";
import { parseJson } from "./json";

/** One move, located, as the planner needs it. */
export interface PlannedMove {
    /** Position in the caller's list, so an error names the right spec line. */
    index: number;
    from: string;
    to: string;
    fromAbs: string;
    toAbs: string;
    blockText: string;
    cutText: string;
    fixImports: boolean;
    /** `visibility=widen`: the planner may export (TS) or widen access (Swift) to make the split compile. */
    widen: boolean;
    /** The move as a spec marker line, so a fix proposal can show the marker to write. */
    marker: string;
    label: string;
}

/** Thrown for a problem that belongs to one move; `index` is its position in the caller's list. */
export class MoveError extends Error {
    readonly index: number;

    constructor(message: string, index: number) {
        super(message);
        this.name = "MoveError";
        this.index = index;
    }
}

const KEY_BEFORE = new Set(["{", ",", ";", "(", "}"]);

/**
 * Whether `masked` refers to `name`. Property access (`a.name`) and an object or interface key
 * (`{ name: 1 }`, `name?: string`) are not references; a spread (`...name`) is.
 */
export const usesName = (masked: string, name: string): boolean => {
    for (const match of masked.matchAll(new RegExp(identifierPattern(name), "g"))) {
        const at = match.index ?? 0;
        let k = at - 1;
        while (k >= 0 && /\s/.test(masked[k])) {
            k--;
        }

        if (masked[k] === "." && masked[k - 1] !== ".") {
            continue;
        }

        let j = at + name.length;
        while (j < masked.length && /[ \t]/.test(masked[j])) {
            j++;
        }

        if (masked[j] === "?") {
            j++;
        }

        const isKey = masked[j] === ":" && masked[j + 1] !== ":" && (k < 0 || KEY_BEFORE.has(masked[k]));
        if (!isKey) {
            return true;
        }
    }

    return false;
};

export const toPosix = (p: string): string => p.split(path.sep).join("/");

/** tsconfig.json allows comments and trailing commas; JSON.parse does not. */
export const parseJsonc = (text: string): unknown => {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === "\\") {
                out += text[i + 1] ?? "";
                i += 2;
                continue;
            }

            if (c === '"') {
                inString = false;
            }

            i++;
            continue;
        }

        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }

        if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") {
                i++;
            }
            continue;
        }

        if (c === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }

        out += c;
        i++;
    }

    return parseJson(out.replace(/,(\s*[}\]])/g, "$1"));
};

export const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const projectFileCache = new Map<string, string[]>();

/** Every file of the repository `cwd` is in (git's view), or under `cwd` itself outside git. */
export const listProjectFiles = (cwd: string): string[] => {
    const cached = projectFileCache.get(cwd);
    if (cached !== undefined) {
        return cached;
    }

    const files = scanProjectFiles(cwd);
    projectFileCache.set(cwd, files);
    return files;
};

const scanProjectFiles = (cwd: string): string[] => {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    if (top.status === 0) {
        const root = top.stdout.trim();
        const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
        });
        if (listed.status === 0) {
            return listed.stdout
                .split("\0")
                .filter((file) => file.length > 0)
                .map((file) => path.join(root, file));
        }
    }

    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === "vendor" || entry.name.startsWith(".")) {
                continue;
            }

            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                out.push(full);
            }
        }
    };
    walk(cwd);
    return out;
};

export const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

export interface PlanImportFixesParams {
    moves: PlannedMove[];
    cwd: string;
    /** Content of a file as the batch sees it before any op, or undefined when it does not exist. */
    read: (abs: string) => string | undefined;
    onWarning?: (message: string) => void;
    /** Overrides the project file list (tests); defaults to git's view of the repository. */
    projectFiles?: string[];
    /** True when an op elsewhere in the same spec already rewrites `needle` in `abs`. */
    isHandled?: (abs: string, needle: string) => boolean;
}

export type ImportLanguage = "ts" | "swift" | "php";

export const importLanguage = (file: string): ImportLanguage | null => {
    if (/\.(?:[cm]?[jt]sx?)$/.test(file)) {
        return "ts";
    }

    if (file.endsWith(".swift")) {
        return "swift";
    }

    return file.endsWith(".php") ? "php" : null;
};

/** What to change in the spec so a warning or refusal goes away, ready to paste. */
export interface FixProposal {
    why: string;
    spec?: string;
}

const indented = (text: string, pad: string): string =>
    text
        .split("\n")
        .map((line) => `${pad}${line}`)
        .join("\n");

export const withFix = (message: string, fix: FixProposal): string =>
    `${message}\n  Fix: ${fix.why}${fix.spec === undefined ? "" : `\n${indented(fix.spec, "    ")}`}`;

/** The move's marker with `option` added, for a fix that is one more modifier. */
export const markerWith = (move: PlannedMove, option: string): string =>
    move.marker.includes(option) ? move.marker : `${move.marker} ${option}`;

export interface PlannedWarning {
    abs: string;
    /** Text the proposed op rewrites; once every needle is handled by a spec op, the warning is dropped. */
    needles: string[];
    message: string;
    fix: FixProposal;
}

export const warnWithFix = (params: PlanImportFixesParams, warning: PlannedWarning): void => {
    const handled =
        warning.needles.length > 0 &&
        warning.needles.every((needle) => params.isHandled?.(warning.abs, needle) === true);
    if (!handled) {
        params.onWarning?.(withFix(warning.message, warning.fix));
    }
};

/** A literal op as spec text: the shape every fix proposal pastes. */
export const literalOpSpec = (file: string, find: string, replace: string, modifiers = ""): string =>
    `@@ ${file}\n<<<${modifiers === "" ? "" : ` ${modifiers}`}\n${find}\n===\n${replace}\n>>>`;
