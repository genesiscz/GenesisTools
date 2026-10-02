import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Every file `tools markdown` changes is copied first, with a patch beside the copy and a line in a
 * manifest, under one folder per run: `/tmp/GenesisTools/transclude/<YYYY-MM-DD_HH-MM-SS>-<pid>/`. The day
 * log gets the same record, so an hour later the log alone says which file changed, how, and how to put
 * it back. /tmp clears on a reboot: the patch is the record that is small enough to keep elsewhere.
 */
export const BACKUP_ROOT = join(process.platform === "win32" ? tmpdir() : "/tmp", "GenesisTools", "transclude");

export interface BackupRecord {
    file: string;
    backup: string;
    patch: string;
    shaBefore: string;
    shaAfter: string;
    restore: string;
    /** True for a dry run: the original is untouched and `proposal` holds the result. */
    dryRun: boolean;
    /** The dry run's result file, `<name>.proposed` beside the backup. */
    proposal?: string;
}

const DIFF_TIMEOUT_MS = 15_000;
/** Backups, patches, proposals and the manifest copy a note's text: readable by its owner only. */
const PRIVATE_FILE = 0o600;

function stamp(now: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** One folder per run: the process id keeps two runs started in the same second apart. */
export function runDirectory(now = new Date()): string {
    const dir = join(BACKUP_ROOT, `${stamp(now)}-${process.pid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
}

function shellQuote(text: string): string {
    return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * A unique name inside the run folder: two notes called Summary.md in one run do not collide. A slot owns
 * `<name>`, `<name>.patch` and `<name>.proposed`, so all three must be free (`Note.md.patch` is a note too).
 */
function slot(runDir: string, file: string): string {
    const name = basename(file);
    let candidate = name;
    let index = 2;
    const taken = (stem: string) =>
        ["", ".patch", ".proposed"].some((suffix) => existsSync(join(runDir, stem + suffix)));

    while (taken(candidate)) {
        candidate = `${index}-${name}`;
        index++;
    }

    return candidate;
}

async function unifiedDiff(fromPath: string, toPath: string): Promise<string> {
    // `git diff --no-index` exits 1 when the files differ; that is the expected outcome here. No external
    // diff helper runs, and a hung git is killed after DIFF_TIMEOUT_MS so the manifest is still written.
    const proc = Bun.spawn(["git", "diff", "--no-index", "--no-ext-diff", "--no-color", "--", fromPath, toPath], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: DIFF_TIMEOUT_MS,
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (proc.signalCode) {
        logger.warn(
            { fromPath, toPath, signal: proc.signalCode, timeoutMs: DIFF_TIMEOUT_MS },
            "markdown: git diff --no-index did not finish in time; the patch file is empty"
        );
        return "";
    }

    if (code > 1) {
        logger.warn(
            { fromPath, toPath, code, stderr },
            "markdown: git diff --no-index failed; the patch file is empty"
        );
    }

    return stdout;
}

/**
 * Copies `before`, writes `after` (to the file itself, atomically, or to `<name>.proposed` in a dry run),
 * then writes the patch and the manifest line. Returns what it did.
 */
export async function backupAndWrite(options: {
    file: string;
    before: string;
    after: string;
    runDir: string;
    dryRun: boolean;
    detail: Record<string, unknown>;
}): Promise<BackupRecord> {
    const { file, before, after, runDir, dryRun } = options;
    const name = slot(runDir, file);
    const backup = join(runDir, name);
    // The copies hold the note's whole text: private to this user, whatever the umask says.
    writeFileSync(backup, before, { mode: PRIVATE_FILE });

    let target = file;

    if (dryRun) {
        target = join(runDir, `${name}.proposed`);
        writeFileSync(target, after, { mode: PRIVATE_FILE });
    } else {
        // The resolve awaited transclusion after reading `before`: an editor may have saved since then.
        if (readFileSync(file, "utf8") !== before) {
            throw new Error("the file changed on disk while its tokens were resolved");
        }

        // A symlinked note is replaced at its target, so the link stays a link. The replacement takes
        // the note's own mode: a private 0600 note must not come back 0644.
        const real = realpathSync(file);
        const temporary = `${real}.md-tmp-${process.pid}`;
        writeFileSync(temporary, after);
        chmodSync(temporary, statSync(real).mode & 0o7777);
        renameSync(temporary, real);
        // The patch compares the text, not the link: git diffs a symlink as its target path.
        target = real;
    }

    const patch = join(runDir, `${name}.patch`);
    writeFileSync(patch, await unifiedDiff(backup, target), { mode: PRIVATE_FILE });

    const record: BackupRecord = {
        file,
        backup,
        patch,
        shaBefore: sha256(before),
        shaAfter: sha256(after),
        restore: `cp ${shellQuote(backup)} ${shellQuote(file)}`,
        dryRun,
        ...(dryRun ? { proposal: target } : {}),
    };
    appendFileSync(
        join(runDir, "manifest.jsonl"),
        `${SafeJSON.stringify({ ...record, ...options.detail, at: new Date().toISOString() })}\n`,
        { mode: PRIVATE_FILE }
    );
    // Debug reaches the day log file always, and the console only with -v: the command prints its own summary.
    logger.debug(
        { ...record, ...options.detail },
        dryRun
            ? "markdown: dry run, proposal written beside the backup"
            : "markdown: file rewritten, backup and patch kept"
    );
    return record;
}
