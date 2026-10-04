import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import pc from "picocolors";
import { MARKETPLACE_FALLBACK_SOURCE, PLUGIN_REF } from "./marketplace";

export interface UpdateCatalogueEntry {
    name: string;
    description: string;
}

export interface UpdateSnapshot {
    version: string | null;
    tools: UpdateCatalogueEntry[];
    skills: UpdateCatalogueEntry[];
}

export interface UpdateDiff {
    previousVersion: string | null;
    currentVersion: string | null;
    versionChanged: boolean;
    toolsAdded: string[];
    toolsRemoved: string[];
    toolsChanged: string[];
    skillsAdded: string[];
    skillsRemoved: string[];
    skillsChanged: string[];
    /** True when ANY of the above fields reports a change; drives whether the full lists are needed. */
    hasChanges: boolean;
}

interface EntryDiff {
    added: string[];
    removed: string[];
    changed: string[];
}

function diffEntries(previous: UpdateCatalogueEntry[], current: UpdateCatalogueEntry[]): EntryDiff {
    const previousByName = new Map(previous.map((entry) => [entry.name, entry.description]));
    const currentByName = new Map(current.map((entry) => [entry.name, entry.description]));

    const added = [...currentByName.keys()].filter((name) => !previousByName.has(name)).sort();
    const removed = [...previousByName.keys()].filter((name) => !currentByName.has(name)).sort();
    const changed = [...currentByName.keys()]
        .filter((name) => previousByName.has(name) && previousByName.get(name) !== currentByName.get(name))
        .sort();

    return { added, removed, changed };
}

/**
 * D4, round 2: `tools update` used to print its full tool and skill catalogue on every run,
 * even when nothing changed. This computes only what moved since the last run, so the normal
 * output can stay short; `--verbose` still prints the full lists.
 */
export function diffUpdateSnapshots(previous: UpdateSnapshot | undefined, current: UpdateSnapshot): UpdateDiff {
    // No previous snapshot means this is the first run ever: establish the baseline silently,
    // rather than reporting the whole catalogue as "added".
    const noPreviousEntries: EntryDiff = { added: [], removed: [], changed: [] };
    const tools = previous === undefined ? noPreviousEntries : diffEntries(previous.tools, current.tools);
    const skills = previous === undefined ? noPreviousEntries : diffEntries(previous.skills, current.skills);
    const versionChanged = previous !== undefined && previous.version !== current.version;

    const hasChanges =
        versionChanged ||
        tools.added.length > 0 ||
        tools.removed.length > 0 ||
        tools.changed.length > 0 ||
        skills.added.length > 0 ||
        skills.removed.length > 0 ||
        skills.changed.length > 0;

    return {
        previousVersion: previous?.version ?? null,
        currentVersion: current.version,
        versionChanged,
        toolsAdded: tools.added,
        toolsRemoved: tools.removed,
        toolsChanged: tools.changed,
        skillsAdded: skills.added,
        skillsRemoved: skills.removed,
        skillsChanged: skills.changed,
        hasChanges,
    };
}

/** One line per kind of change, in a fixed order; empty array when {@link UpdateDiff.hasChanges} is false. */
export function formatUpdateDiff(diff: UpdateDiff): string[] {
    const lines: string[] = [];

    if (diff.versionChanged) {
        lines.push(
            diff.previousVersion
                ? `Version: ${diff.previousVersion} -> ${diff.currentVersion}`
                : `Version: ${diff.currentVersion}`
        );
    }

    if (diff.toolsAdded.length > 0) {
        lines.push(`Commands added: ${diff.toolsAdded.join(", ")}`);
    }

    if (diff.toolsRemoved.length > 0) {
        lines.push(`Commands removed: ${diff.toolsRemoved.join(", ")}`);
    }

    if (diff.toolsChanged.length > 0) {
        lines.push(`Commands changed: ${diff.toolsChanged.join(", ")}`);
    }

    if (diff.skillsAdded.length > 0) {
        lines.push(`Skills added: ${diff.skillsAdded.join(", ")}`);
    }

    if (diff.skillsRemoved.length > 0) {
        lines.push(`Skills removed: ${diff.skillsRemoved.join(", ")}`);
    }

    if (diff.skillsChanged.length > 0) {
        lines.push(`Skills changed: ${diff.skillsChanged.join(", ")}`);
    }

    return lines;
}

function defaultSnapshotPath(): string {
    return join(toolDataDir("update"), "catalogue-snapshot.json");
}

function isCatalogueEntry(entry: unknown): entry is UpdateCatalogueEntry {
    return (
        entry !== null &&
        typeof entry === "object" &&
        "name" in entry &&
        typeof entry.name === "string" &&
        "description" in entry &&
        typeof entry.description === "string"
    );
}

function isCatalogue(value: unknown): value is UpdateCatalogueEntry[] {
    return Array.isArray(value) && value.every((entry: unknown) => isCatalogueEntry(entry));
}

function isUpdateSnapshot(value: unknown): value is UpdateSnapshot {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const version = "version" in value ? value.version : undefined;

    return (
        (version === null || typeof version === "string") &&
        "tools" in value &&
        isCatalogue(value.tools) &&
        "skills" in value &&
        isCatalogue(value.skills)
    );
}

/**
 * Takes an explicit path so a test never touches the real HOME. A file that does not parse, or
 * parses to anything but a snapshot, reads as no snapshot: the diff below must never see it.
 */
export function readUpdateSnapshot(path: string = defaultSnapshotPath()): UpdateSnapshot | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        logger.debug({ error, path }, "update: catalogue snapshot unreadable, treating as first run");
        return undefined;
    }

    if (!isUpdateSnapshot(parsed)) {
        logger.debug({ path }, "update: catalogue snapshot has the wrong shape, treating as first run");
        return undefined;
    }

    return parsed;
}

export function writeUpdateSnapshot(snapshot: UpdateSnapshot, path: string = defaultSnapshotPath()): void {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${SafeJSON.stringify(snapshot, null, 2)}\n`);
    } catch (error) {
        logger.debug({ error, path }, "update: could not persist catalogue snapshot");
    }
}

export interface UpdateCatalogueInput {
    current: UpdateSnapshot;
    verbose: boolean;
    println: (line: string) => void;
    /** Defaults to the real snapshot file; tests pass a temp path. */
    snapshotPath?: string;
}

/**
 * Step 6 of `tools update`: the full tool and skill lists with `--verbose`, otherwise only what
 * changed since the last run. The snapshot advances on EVERY run: a verbose run that skipped it
 * left an older baseline, so the next normal run reported the same changes again.
 */
export function printUpdateCatalogue(input: UpdateCatalogueInput): void {
    const { current, println } = input;
    const path = input.snapshotPath ?? defaultSnapshotPath();
    const diffLines = formatUpdateDiff(diffUpdateSnapshots(readUpdateSnapshot(path), current));
    writeUpdateSnapshot(current, path);

    if (input.verbose) {
        println(pc.cyan("  Did you know we have a lot of Claude tools available? Install with:\n"));
        println(`    claude plugin marketplace add ${MARKETPLACE_FALLBACK_SOURCE}`);
        println(`    claude plugin install ${PLUGIN_REF}\n`);

        println(pc.cyan("  Available commands:"));
        for (const tool of current.tools) {
            println(`    ${pc.bold(tool.name)} - ${pc.dim(tool.description)}`);
        }

        println(pc.cyan("\n  Available skills:"));
        for (const skill of current.skills) {
            println(`    ${pc.bold(`gt:${skill.name}`)} - ${pc.dim(skill.description)}`);
        }

        return;
    }

    if (diffLines.length === 0) {
        println(pc.dim("  No catalogue changes since the last update. Run with --verbose to see everything."));
        return;
    }

    for (const line of diffLines) {
        println(`  ${line}`);
    }
}
