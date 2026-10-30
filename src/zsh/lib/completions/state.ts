import { SafeJSON } from "@genesiscz/utils/json";
import {
    atomicWriteFileSync,
    isJsonObject,
    readFileIfExistsSync,
    readJsonFileForUpdateSync,
} from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { CompletionWiring } from "./providers";
import type { ReplacedHandBlock } from "./rc-block";

/** One generated completion file. */
export interface InstalledCompletion {
    file: string;
    wiring: CompletionWiring;
    /** The first line `<cli> --version` printed when the file was generated, when it printed one. */
    version?: string;
    generatedAt: string;
    sha256: string;
}

/** `~/.genesis-tools/zsh/completions.json`. Keyed by CLI, so each CLI owns its own entry. */
export interface CompletionsState {
    version: 1;
    /** The rc file that holds the block. */
    rc?: string;
    clis: Record<string, InstalledCompletion>;
    /**
     * Hand blocks the tool replaced, per CLI, with their original lines. `uninstall` and deselecting a CLI put them
     * back. Kept apart from `clis` because `refresh` rewrites those entries and must not lose these.
     */
    replacedHand?: Record<string, ReplacedHandBlock[]>;
}

export function completionsDir(): string {
    return toolDataDir("zsh", "completions");
}

export function completionsStatePath(): string {
    return toolDataDir("zsh", "completions.json");
}

export function emptyState(): CompletionsState {
    return { version: 1, clis: {} };
}

function isInstalledCompletion(value: unknown): value is InstalledCompletion {
    return (
        isJsonObject(value) &&
        typeof value.file === "string" &&
        (value.wiring === "fpath" || value.wiring === "source") &&
        typeof value.generatedAt === "string" &&
        typeof value.sha256 === "string" &&
        (value.version === undefined || typeof value.version === "string")
    );
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isReplacedHandBlock(value: unknown): value is ReplacedHandBlock {
    return isJsonObject(value) && isStringArray(value.original) && isStringArray(value.replacement);
}

export function isCompletionsState(value: unknown): value is CompletionsState {
    return (
        isJsonObject(value) &&
        (value.rc === undefined || typeof value.rc === "string") &&
        isJsonObject(value.clis) &&
        Object.values(value.clis).every(isInstalledCompletion) &&
        (value.replacedHand === undefined ||
            (isJsonObject(value.replacedHand) &&
                Object.values(value.replacedHand).every(
                    (records) => Array.isArray(records) && records.every(isReplacedHandBlock)
                )))
    );
}

/**
 * The state for a read-only command (`--list`, `--dry-run`): a missing or unreadable file reads as empty and
 * nothing is written. `problem` says why it was not used.
 */
export function readStateReadOnly(path = completionsStatePath()): { state: CompletionsState; problem?: string } {
    const bytes = readFileIfExistsSync(path);

    if (bytes === undefined) {
        return { state: emptyState() };
    }

    try {
        const value: unknown = SafeJSON.parse(Buffer.from(bytes).toString("utf8"));

        if (isCompletionsState(value)) {
            return { state: value };
        }

        return { state: emptyState(), problem: `${path} has an unexpected shape` };
    } catch (error) {
        return { state: emptyState(), problem: `${path} does not parse: ${String(error)}` };
    }
}

/** The state for a command that rewrites it; an unreadable file is copied aside first and reads as empty. */
export function readStateForUpdate(path = completionsStatePath()): CompletionsState {
    const read = readJsonFileForUpdateSync<CompletionsState>(path, { accepts: isCompletionsState });
    return read.state === "ok" ? read.value : emptyState();
}

export function writeState(state: CompletionsState, path = completionsStatePath()): void {
    atomicWriteFileSync(path, `${SafeJSON.stringify(state, null, 2)}\n`);
}
