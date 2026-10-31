import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { defaultTrashRoot } from "./paths";

/** A folder the user trusts an agent to delete anything inside (the hard-deny rules still apply). */
export interface RmRoot {
    path: string;
    note?: string;
    addedAt: string;
    /** How it was added: `cli` (`tools rm roots add`) or `request:<id>` (an approved agent request). */
    via: string;
}

/**
 * A kind of folder that is safe to delete because a build or an install recreates it. A match needs its name
 * (`*` globs allowed) and, when `markers` is set, one of those files beside it; `parentNames` restricts the
 * folder it may sit in, and `within` makes every child of one fixed folder a match.
 */
export interface RmPreset {
    id: string;
    description: string;
    names: string[];
    markers?: string[];
    parentNames?: string[];
    within?: string;
    /** Off until `tools rm config set enable-preset <id>`: shared caches another install may be reading. */
    optIn?: boolean;
}

/** What happens to a path that needs the user: `aside` moves it into the session's aside folder, `request` leaves it. */
export type RmAskAction = "aside" | "request";

/**
 * How a person confirms: `auto` uses Touch ID through GenesisTools.app when the installed app offers it and falls back
 * to `code` otherwise; `touch-id` refuses without the app; `code` is the typed code on a terminal, or the macOS dialog.
 */
export type RmApproval = "auto" | "touch-id" | "code";

export const RM_APPROVALS: readonly RmApproval[] = ["auto", "touch-id", "code"];

/** The settings a profile may change. Lists add to the base config; scalars replace it. */
export interface RmPolicy {
    askAction: RmAskAction;
    /** Also move unsaved work aside (untracked files, clones with unpushed work), which /tmp loses on reboot. */
    asideUnsaved: boolean;
    /** The session-scratch rule: the caller's own /tmp scratch folder goes without asking. */
    allowSessionScratch: boolean;
    /** The own-files rule: files the caller's session wrote go without asking. */
    allowOwnFiles: boolean;
}

/** Which callers a profile applies to. Every field that is set must match. */
export interface RmProfileMatch {
    /** `claude-code`, `codex`, `grok`, `copilot`, or `person` for a run outside any agent; a comma list matches any. */
    agent?: string;
    /** A session id or its prefix. */
    session?: string;
    /** The project folder name (the main checkout's). */
    project?: string;
    /** The run's folder, or a folder above it. */
    cwd?: string;
}

/** Settings for some callers: one agent, one session, one project. Profiles that match apply in order. */
export interface RmProfile extends Partial<RmPolicy> {
    name: string;
    /** Shipped with tools rm; turned off with `tools rm config set disable-profile <name>`. */
    builtin?: boolean;
    match: RmProfileMatch;
    grace?: Partial<RmConfig["grace"]>;
    disabledPresets?: string[];
    roots?: string[];
    protect?: string[];
    note?: string;
}

export interface RmConfig extends RmPolicy {
    roots: RmRoot[];
    /** Extra paths that are never deleted, nor any folder that contains one. */
    protect: string[];
    /** Minutes a moved-aside item waits before the drain deletes it, so `tools rm restore` can bring it back. */
    grace: { presetMinutes: number; otherMinutes: number };
    trashRoot: string;
    disabledPresets: string[];
    /** Opt-in presets the user turned on. */
    enabledPresets: string[];
    customPresets: RmPreset[];
    profiles: RmProfile[];
    /** Built-in profiles the user turned off, by name. */
    disabledProfiles: string[];
    /** How a person confirms. Not a profile setting: it belongs to the person, not to the caller. */
    approval: RmApproval;
}

export function rmDataDir(...segments: string[]): string {
    return toolDataDir("rm", ...segments);
}

export function rmConfigPath(): string {
    return rmDataDir("config.json");
}

export function defaultRmConfig(): RmConfig {
    return {
        roots: [],
        protect: [],
        grace: { presetMinutes: 0, otherMinutes: 60 },
        trashRoot: defaultTrashRoot(),
        disabledPresets: [],
        enabledPresets: [],
        customPresets: [],
        profiles: [],
        disabledProfiles: [],
        approval: "auto",
        askAction: "aside",
        asideUnsaved: false,
        allowSessionScratch: true,
        allowOwnFiles: true,
    };
}

export function loadRmConfig(path = rmConfigPath()): RmConfig {
    let contents: string;
    try {
        contents = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            try {
                lstatSync(path);
            } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
                    return defaultRmConfig();
                }
            }
        }
        throw new Error(`rm: cannot read safety config ${path}; fix it before deleting`, { cause: error });
    }

    try {
        const raw: unknown = SafeJSON.parse(contents, { strict: true });
        validateRmConfig(raw);
        return parseRmConfig(raw);
    } catch (error) {
        throw new Error(`rm: invalid safety config ${path}; fix it before deleting`, { cause: error });
    }
}

export function saveRmConfig(config: RmConfig, path = rmConfigPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(config, null, 4)}\n`);
    logger.debug({ path, roots: config.roots.length }, "rm: config saved");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRmConfig(value: unknown): void {
    if (!isRecord(value)) {
        throw new Error("config must be an object");
    }
    const check = (object: Record<string, unknown>, key: string, valid: (v: unknown) => boolean): void => {
        if (key in object && !valid(object[key])) {
            throw new Error(`invalid ${key}`);
        }
    };
    const text = (v: unknown): boolean => typeof v === "string";
    const boolean = (v: unknown): boolean => typeof v === "boolean";
    const texts = (v: unknown): boolean => Array.isArray(v) && v.every(text);
    const nonnegative = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
    const grace = (v: unknown): boolean => {
        if (!isRecord(v)) {
            return false;
        }
        check(v, "presetMinutes", nonnegative);
        check(v, "otherMinutes", nonnegative);
        return true;
    };
    const policy = (v: Record<string, unknown>): void => {
        for (const key of ["asideUnsaved", "allowSessionScratch", "allowOwnFiles"]) {
            check(v, key, boolean);
        }
        check(v, "askAction", isAskAction);
        check(v, "grace", grace);
    };
    for (const key of ["protect", "disabledPresets", "enabledPresets", "disabledProfiles"]) {
        check(value, key, texts);
    }
    policy(value);
    check(value, "approval", isRmApproval);
    check(value, "trashRoot", isTrashRootName);
    check(value, "roots", (v) => Array.isArray(v) && v.every((item) => parseRoot(item) !== null));
    check(
        value,
        "customPresets",
        (v) =>
            Array.isArray(v) &&
            v.every((item) => {
                if (!isRecord(item) || parsePreset(item) === null) {
                    return false;
                }
                for (const key of ["description", "within"]) {
                    check(item, key, text);
                }
                for (const key of ["names", "markers", "parentNames"]) {
                    check(item, key, texts);
                }
                check(item, "optIn", boolean);
                return true;
            })
    );
    check(
        value,
        "profiles",
        (v) =>
            Array.isArray(v) &&
            v.every((item) => {
                if (!isRecord(item) || parseProfile(item) === null || !isRecord(item.match)) {
                    return false;
                }
                for (const key of ["agent", "session", "project", "cwd"]) {
                    check(item.match, key, text);
                }
                for (const key of ["disabledPresets", "roots", "protect"]) {
                    check(item, key, texts);
                }
                check(item, "note", text);
                policy(item);
                return true;
            })
    );
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function minutes(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseRoot(value: unknown): RmRoot | null {
    if (!isRecord(value) || typeof value.path !== "string") {
        return null;
    }

    return {
        path: value.path,
        note: typeof value.note === "string" ? value.note : undefined,
        addedAt: typeof value.addedAt === "string" ? value.addedAt : "",
        via: typeof value.via === "string" ? value.via : "cli",
    };
}

function parsePreset(value: unknown): RmPreset | null {
    if (!isRecord(value) || typeof value.id !== "string") {
        return null;
    }

    const names = strings(value.names);

    if (names.length === 0 && typeof value.within !== "string") {
        return null;
    }

    return {
        id: value.id,
        description: typeof value.description === "string" ? value.description : "custom preset",
        names,
        markers: Array.isArray(value.markers) ? strings(value.markers) : undefined,
        parentNames: Array.isArray(value.parentNames) ? strings(value.parentNames) : undefined,
        within: typeof value.within === "string" ? value.within : undefined,
        optIn: value.optIn === true ? true : undefined,
    };
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function optionalBool(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

export function isRmApproval(value: unknown): value is RmApproval {
    return RM_APPROVALS.some((approval) => approval === value);
}

export function isAskAction(value: unknown): value is RmAskAction {
    return value === "aside" || value === "request";
}

function optionalMinutes(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseProfile(value: unknown): RmProfile | null {
    if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.match)) {
        return null;
    }

    const m = value.match;
    const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    const grace = isRecord(value.grace) ? value.grace : null;

    return {
        name: value.name,
        match: { agent: text(m.agent), session: text(m.session), project: text(m.project), cwd: text(m.cwd) },
        askAction: isAskAction(value.askAction) ? value.askAction : undefined,
        asideUnsaved: optionalBool(value.asideUnsaved),
        allowSessionScratch: optionalBool(value.allowSessionScratch),
        allowOwnFiles: optionalBool(value.allowOwnFiles),
        grace: grace
            ? { presetMinutes: optionalMinutes(grace.presetMinutes), otherMinutes: optionalMinutes(grace.otherMinutes) }
            : undefined,
        disabledPresets: Array.isArray(value.disabledPresets) ? strings(value.disabledPresets) : undefined,
        roots: Array.isArray(value.roots) ? strings(value.roots) : undefined,
        protect: Array.isArray(value.protect) ? strings(value.protect) : undefined,
        note: text(value.note),
    };
}

/**
 * A trash root must carry a `GenesisTools` folder in its path: the drain deletes everything inside the root, so a
 * root edited to `~` or `/` would turn it into a plain `rm -rf`. The path must be plain (no `.` or `..` step), since
 * `/tmp/GenesisTools/../../home/alice` names the home folder. Any other value falls back to the default.
 */
export function isTrashRootName(value: unknown): value is string {
    if (typeof value !== "string" || !isAbsolute(value)) {
        return false;
    }

    const segments = value.split(/[\\/]/).filter(Boolean);
    return !segments.some((s) => s === "." || s === "..") && segments.includes("GenesisTools");
}

export function parseRmConfig(raw: unknown): RmConfig {
    const defaults = defaultRmConfig();

    if (!isRecord(raw)) {
        return defaults;
    }

    const grace = isRecord(raw.grace) ? raw.grace : {};

    return {
        roots: Array.isArray(raw.roots) ? raw.roots.map(parseRoot).filter((r): r is RmRoot => r !== null) : [],
        protect: strings(raw.protect),
        grace: {
            presetMinutes: minutes(grace.presetMinutes, defaults.grace.presetMinutes),
            otherMinutes: minutes(grace.otherMinutes, defaults.grace.otherMinutes),
        },
        trashRoot: isTrashRootName(raw.trashRoot) ? raw.trashRoot : defaults.trashRoot,
        disabledPresets: strings(raw.disabledPresets),
        enabledPresets: strings(raw.enabledPresets),
        disabledProfiles: strings(raw.disabledProfiles),
        customPresets: Array.isArray(raw.customPresets)
            ? raw.customPresets.map(parsePreset).filter((p): p is RmPreset => p !== null)
            : [],
        profiles: Array.isArray(raw.profiles)
            ? raw.profiles.map(parseProfile).filter((p): p is RmProfile => p !== null)
            : [],
        approval: isRmApproval(raw.approval) ? raw.approval : defaults.approval,
        askAction: isAskAction(raw.askAction) ? raw.askAction : defaults.askAction,
        asideUnsaved: bool(raw.asideUnsaved, defaults.asideUnsaved),
        allowSessionScratch: bool(raw.allowSessionScratch, defaults.allowSessionScratch),
        allowOwnFiles: bool(raw.allowOwnFiles, defaults.allowOwnFiles),
    };
}
