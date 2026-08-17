/**
 * The script journal.
 *
 * Every persisted script gets an entry recording where and why it was made:
 * the cwd it was created from, an inferred project, free-form tags, the tool
 * selectors it was scaffolded with, and run statistics.
 *
 * Metadata never gates execution. Any script can be RUN from anywhere. The one
 * visibility rule is `gated`: a gated script is hidden from `list` outside the
 * directory tree it was created for (`--all` reveals it), which keeps a global
 * store readable without ever blocking you.
 *
 * Every function takes an optional store root so tests run against a temp
 * directory; production callers omit it and get `~/.genesis-tools/scripts`.
 */
import { mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { pathExists, persistedDir, storeRoot, trashDir } from "./store.ts";

export { findProjectRoot };

export interface ScriptPaths {
    /** The script's own directory. Sidecars (presets, state, output) belong here. */
    dir: string;
    file: string;
    toolsFile: string;
}

/**
 * Where a script lives: `persisted/<name>/<name>.ts`.
 *
 * A directory per script rather than a flat pile, because a script that does
 * real work grows sidecars — a preset, a state file, a progress log — and in a
 * flat layout those interleave with other scripts' files until nothing is
 * findable.
 */
export function scriptPaths(name: string, root = storeRoot()): ScriptPaths {
    const dir = join(persistedDir(root), name);

    return { dir, file: join(dir, `${name}.ts`), toolsFile: join(dir, `${name}.tools.ts`) };
}

export interface RunRecord {
    at: string;
    cwd: string;
    exitCode: number;
    durationMs: number;
}

export interface ScriptEntry {
    name: string;
    file: string;
    description?: string;
    imports: string[];
    /** Fully-resolved `server.tool` refs the scaffold bound at creation time. */
    tools: string[];
    servers: string[];
    tags: string[];
    project?: string;
    /** Set when the script is visibility-gated: hidden from `list` outside this directory tree. */
    gateDir?: string;
    createdFrom: string;
    createdAt: string;
    updatedAt: string;
    runs: number;
    lastRun?: RunRecord;
}

export interface Journal {
    version: 1;
    scripts: ScriptEntry[];
}

/**
 * Always a fresh object: callers push into `scripts`, and a shared constant
 * here would leak one caller's entries into every later "empty" read.
 */
function emptyJournal(): Journal {
    return { version: 1, scripts: [] };
}

function journalPath(root: string): string {
    return join(persistedDir(root), "_journal.json");
}

export type JournalHealth = "missing" | "ok" | "corrupt";

/** Pure inspection for diagnostics: reports corruption without writing the backup that readJournal would. */
export async function journalHealth(root = storeRoot()): Promise<JournalHealth> {
    const file = Bun.file(journalPath(root));

    if (!(await file.exists())) {
        return "missing";
    }

    try {
        const parsed = SafeJSON.parse(await file.text(), { strict: true }) as Journal;
        return Array.isArray(parsed?.scripts) ? "ok" : "corrupt";
    } catch (error) {
        logger.debug({ root, error }, "journal health check found unparseable content");
        return "corrupt";
    }
}

/**
 * A missing journal is an empty store. A journal that EXISTS but cannot be
 * parsed is not: returning empty would let the next `create`/`tag`/`recordRun`
 * overwrite the file and silently discard every entry. The unparseable content
 * is backed up beside the journal first, so nothing a later write does can
 * destroy it, and the failure is loud in the log.
 */
export async function readJournal(root = storeRoot()): Promise<Journal> {
    const file = Bun.file(journalPath(root));

    if (!(await file.exists())) {
        return emptyJournal();
    }

    const raw = await file.text();

    try {
        const parsed = SafeJSON.parse(raw, { strict: true }) as Journal;

        if (!Array.isArray(parsed?.scripts)) {
            throw new Error("journal has no scripts array");
        }

        return parsed;
    } catch (error) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backup = join(persistedDir(root), `_journal.corrupt-${stamp}.json`);
        atomicWriteFileSync(backup, raw);
        logger.warn({ root, backup, error }, "journal unparseable — original backed up, starting from empty");
        return emptyJournal();
    }
}

export async function writeJournal(journal: Journal, root = storeRoot()): Promise<void> {
    await mkdir(persistedDir(root), { recursive: true });
    atomicWriteFileSync(journalPath(root), `${SafeJSON.stringify(journal, { strict: true }, 2)}\n`);
}

/**
 * Serialise a read-modify-write cycle under a cross-process file lock. The
 * atomic rename in writeJournal prevents torn files, but not a concurrent
 * `run`/`tag`/`create`/`rm` reading the same journal and the later writer
 * silently discarding the earlier update. A throwing `fn` skips the write.
 */
async function mutateJournal<T>(root: string, fn: (journal: Journal) => Promise<T> | T): Promise<T> {
    return withFileLock(`${journalPath(root)}.lock`, async () => {
        const journal = await readJournal(root);
        const before = SafeJSON.stringify(journal, { strict: true });
        const result = await fn(journal);

        // A no-op mutator (entry not found) must not rewrite the file: that
        // bumps the mtime and widens the concurrency window for nothing.
        if (SafeJSON.stringify(journal, { strict: true }) !== before) {
            await writeJournal(journal, root);
        }

        return result;
    });
}

export async function getEntry(name: string, root = storeRoot()): Promise<ScriptEntry | undefined> {
    const journal = await readJournal(root);
    return journal.scripts.find((s) => s.name === name);
}

/**
 * Whole-record replacement, for callers that OWN the record (`create` writes a
 * brand-new entry). Field updates on an existing entry must go through
 * `mutateEntry` instead: a detached read-mutate-upsert cycle would restore
 * stale fields (say, a `runs` count a concurrent `run` just bumped).
 */
export async function upsertEntry(entry: ScriptEntry, root = storeRoot()): Promise<void> {
    await mutateJournal(root, (journal) => {
        const index = journal.scripts.findIndex((s) => s.name === entry.name);

        if (index === -1) {
            journal.scripts.push(entry);
        } else {
            journal.scripts[index] = entry;
        }
    });
}

/**
 * Mutate one entry's fields inside the journal lock. Returns false when no
 * entry by that name exists (nothing is written then).
 */
export async function mutateEntry(
    name: string,
    fn: (entry: ScriptEntry) => Promise<void> | void,
    root = storeRoot()
): Promise<boolean> {
    return mutateJournal(root, async (journal) => {
        const entry = journal.scripts.find((s) => s.name === name);

        if (!entry) {
            return false;
        }

        await fn(entry);
        return true;
    });
}

export async function recordRun(name: string, record: RunRecord, root = storeRoot()): Promise<void> {
    await mutateJournal(root, (journal) => {
        const entry = journal.scripts.find((s) => s.name === name);

        if (!entry) {
            return;
        }

        entry.runs += 1;
        entry.lastRun = record;
        entry.updatedAt = new Date().toISOString();
    });
}

export interface TrashResult {
    from: string;
    to: string;
    /** False when the directory was already gone and only the stale journal entry was dropped. */
    moved: boolean;
}

/**
 * Move a script out of persisted/ into trash/ and drop its journal entry.
 *
 * Deliberately a move, not a delete: a scratch script can represent an hour of
 * fiddling and the cost of keeping the file is nothing. Only a source that is
 * ALREADY GONE is treated as ignorable; any other rename failure (permissions,
 * full disk, destination collision) rethrows before the journal is touched,
 * because dropping the entry then would strand the script on disk while making
 * it unreachable through list/run/rm.
 */
export async function trashEntry(name: string, root = storeRoot()): Promise<TrashResult | undefined> {
    return mutateJournal(root, async (journal) => {
        const index = journal.scripts.findIndex((s) => s.name === name);

        if (index === -1) {
            return undefined;
        }

        const entry = journal.scripts[index] as ScriptEntry;
        await mkdir(trashDir(root), { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const paths = scriptPaths(entry.name, root);
        const to = join(trashDir(root), `${stamp}-${entry.name}`);
        let moved = true;

        try {
            // The whole directory goes, so sidecars travel with the script.
            await rename(paths.dir, to);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }

            // Already gone; still drop the journal entry so list stays honest.
            logger.debug({ name, error }, "script directory already absent; dropping stale journal entry");
            moved = false;
        }

        journal.scripts.splice(index, 1);
        return { from: paths.dir, to, moved };
    });
}

export interface RenameResult {
    from: string;
    to: string;
    dir: string;
    moved: string[];
}

export const SCRIPT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Rename a script, its directory, its generated bindings and its sidecars.
 *
 * Done by hand this is four separate mistakes waiting to happen: the folder,
 * the file names, the `./<name>.tools.ts` import inside the body, and the
 * journal's absolute path. One verb keeps them consistent.
 */
export async function renameScript(from: string, to: string, root = storeRoot()): Promise<RenameResult> {
    if (!SCRIPT_NAME_RE.test(to)) {
        throw new Error(`Invalid script name '${to}'. Use letters, digits, dash, underscore; start with a letter.`);
    }

    const source = scriptPaths(from, root);

    if (!(await pathExists(source.file))) {
        throw new Error(`No script named '${from}'.`);
    }

    const target = scriptPaths(to, root);

    if (await pathExists(target.file)) {
        throw new Error(`'${to}' already exists at ${target.file}.`);
    }

    await mkdir(target.dir, { recursive: true });
    const moved: string[] = [];

    for (const file of await readdir(source.dir)) {
        // Subdirectories (plans/, out/) travel whole and keep their names; only
        // files carrying the script's name get re-stemmed, so
        // `spotifyPreview.state.json` under a new name keeps `.state.json`.
        const renamed = file.startsWith(`${from}.`) ? `${to}.${file.slice(from.length + 1)}` : file;
        await rename(join(source.dir, file), join(target.dir, renamed));
        moved.push(file === renamed ? file : `${file} → ${renamed}`);
    }

    for (const file of await readdir(target.dir)) {
        if (!file.endsWith(".ts")) {
            continue;
        }

        const path = join(target.dir, file);
        const before = await Bun.file(path).text();
        const after = before
            .replaceAll(`./${from}.tools.ts`, `./${to}.tools.ts`)
            .replaceAll(`scripts run ${from}`, `scripts run ${to}`);

        if (after !== before) {
            await Bun.write(path, after);
        }
    }

    try {
        await rmdir(source.dir);
    } catch (error) {
        // Non-empty because something unexpected lives there; leave it rather than guess.
        logger.debug({ dir: source.dir, error }, "source dir left in place after rename");
    }

    await mutateJournal(root, (journal) => {
        const entry = journal.scripts.find((s) => s.name === from);

        if (entry) {
            entry.name = to;
            entry.file = target.file;
            entry.updatedAt = new Date().toISOString();
        }
    });

    return { from, to, dir: target.dir, moved };
}

export interface FilterOptions {
    tag?: string[];
    project?: string;
    cwd?: string;
    server?: string;
    grep?: string;
    /** Include gated scripts whose gateDir does not contain `visibleFrom`. */
    all?: boolean;
    /** Directory the listing is viewed from; drives gating. Defaults to process.cwd(). */
    visibleFrom?: string;
}

/** True when `dir` is `gateDir` itself or below it. */
function insideGate(gateDir: string, dir: string): boolean {
    return dir === gateDir || dir.startsWith(`${gateDir}/`);
}

export function filterScripts(scripts: ScriptEntry[], filter: FilterOptions): ScriptEntry[] {
    const visibleFrom = filter.visibleFrom ?? process.cwd();

    return scripts.filter((s) => {
        if (!filter.all && s.gateDir && !insideGate(s.gateDir, visibleFrom)) {
            return false;
        }

        if (filter.tag && filter.tag.length > 0) {
            const has = filter.tag.every((t) => s.tags.some((own) => own.toLowerCase() === t.toLowerCase()));

            if (!has) {
                return false;
            }
        }

        if (filter.project && (s.project ?? "").toLowerCase() !== filter.project.toLowerCase()) {
            return false;
        }

        if (filter.cwd && !insideGate(filter.cwd, s.createdFrom)) {
            return false;
        }

        if (filter.server && !s.servers.some((sv) => sv.toLowerCase() === filter.server?.toLowerCase())) {
            return false;
        }

        if (filter.grep) {
            const needle = filter.grep.toLowerCase();
            const hay = `${s.name} ${s.description ?? ""} ${s.tags.join(" ")} ${s.tools.join(" ")}`.toLowerCase();

            if (!hay.includes(needle)) {
                return false;
            }
        }

        return true;
    });
}

/**
 * Best-effort project name for a directory: the git repo's folder name, else
 * the folder name itself. Used only as a default for `--project`.
 */
export function inferProject(cwd: string): string {
    return basename(findProjectRoot(cwd) ?? cwd);
}
