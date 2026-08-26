/**
 * The script store on disk.
 *
 * Everything `tools scripts` persists lives under `~/.genesis-tools/scripts/`:
 *
 *   persisted/<name>/        one script, its generated bindings, its sidecars
 *   persisted/_journal.json  metadata + run history (see journal.ts)
 *   cache/registry.json      last mcp-manager scan
 *   cache/tools.json         per-server tools/list
 *   trash/                   where `rm` moves things; nothing is deleted outright
 *   tsconfig.json            generated: maps @gt/scripts/* into this repo checkout
 *   package.json             script-local npm deps (commander, picocolors, ...)
 *
 * The tsconfig alias is what lets a persisted script that lives OUTSIDE the
 * repo import the runtime with `import { withKit } from "@gt/scripts/kit"` and
 * still run under plain `bun <script>`: Bun resolves the nearest tsconfig.json
 * upward from the entry file, finds the store's, and follows the mapping into
 * `src/scripts/lib/`. Verified 2026-08-17: the repo's own `@genesiscz/*`
 * aliases keep resolving inside the mapped files (per-package tsconfig).
 */
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

/** Absolute path to this GenesisTools checkout's `src/scripts/lib/`. `import.meta.dir` is already percent-decoded, unlike `new URL(...).pathname`. */
export const LIB_DIR = import.meta.dir;

/** Existence probe. ENOENT is the expected miss; anything else is logged so a permission error is not mistaken for absence. */
export async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.debug({ path, error }, "existence probe failed with a non-ENOENT error");
        }

        return false;
    }
}

/** `~/.genesis-tools/scripts`, honoring the test override GENESIS_TOOLS_HOME. */
export function storeRoot(): string {
    return join(env.tools.getHome() || homedir(), ".genesis-tools", "scripts");
}

export function persistedDir(root = storeRoot()): string {
    return join(root, "persisted");
}

export function cacheDir(root = storeRoot()): string {
    return join(root, "cache");
}

export function trashDir(root = storeRoot()): string {
    return join(root, "trash");
}

/**
 * Script-local npm deps. `mcporter` is deliberately absent: only repo files
 * (kit.ts) import it, so it resolves from the repo's node_modules. Scripts add
 * their own extras here (`bun add` in the store) — pixelmatch/pngjs ship by
 * default because the migrated figma script diffs screenshots.
 */
const STORE_PACKAGE_JSON = {
    name: "genesis-scripts-store",
    private: true,
    type: "module",
    dependencies: {
        commander: "^15.0.0",
        picocolors: "^1.1.1",
        pixelmatch: "^7.2.0",
        pngjs: "^7.0.0",
    },
    devDependencies: {
        "@types/bun": "^1.3.14",
        "@types/pngjs": "^6.0.5",
    },
};

export async function runGit(
    root: string,
    args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);

    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

const STORE_GITIGNORE = `node_modules/
cache/
trash/
persisted/*/out/
persisted/*/out-*/
persisted/*/.cache/
*.tmp
`;

/**
 * The store is a plain LOCAL git repo, so every persisted script is versioned.
 * No remote is ever configured — add one yourself if you want off-machine
 * history (`git -C ~/.genesis-tools/scripts remote add origin …`).
 */
async function ensureStoreGit(root: string): Promise<void> {
    if (await pathExists(join(root, ".git"))) {
        return;
    }

    const init = await runGit(root, ["init", "-b", "main"]);

    if (init.exitCode !== 0) {
        logger.warn({ root, stderr: init.stderr }, "git init of the script store failed; versioning disabled");
        return;
    }

    if (!(await pathExists(join(root, ".gitignore")))) {
        atomicWriteFileSync(join(root, ".gitignore"), STORE_GITIGNORE);
    }

    logger.debug({ root }, "script store git repo initialised");
    await commitStore("chore: init script store", root);
}

export interface StoreConfig {
    /** The user's standing remote decision: set up, or explicitly declined. */
    remote?: {
        url?: string;
        /** True when the user said "no remote, stop offering". */
        declined?: boolean;
        /** Push after every store commit. Off unless asked for. */
        autoPush?: boolean;
        decidedAt: string;
    };
}

function storeConfigPath(root: string): string {
    return join(root, "config.json");
}

/** Local decision state (never committed: the allowlist excludes it). */
export async function readStoreConfig(root = storeRoot()): Promise<StoreConfig> {
    try {
        return SafeJSON.parse(await Bun.file(storeConfigPath(root)).text(), { strict: true }) as StoreConfig;
    } catch (error) {
        logger.debug({ root, error }, "store config read fell back to empty");
        return {};
    }
}

export async function writeStoreConfig(config: StoreConfig, root = storeRoot()): Promise<void> {
    atomicWriteFileSync(storeConfigPath(root), `${SafeJSON.stringify(config, { strict: true }, 2)}\n`);
}

/** The store's `origin` url, or undefined when no remote is configured. */
export async function storeRemoteUrl(root = storeRoot()): Promise<string | undefined> {
    if (!(await pathExists(join(root, ".git")))) {
        return undefined;
    }

    const result = await runGit(root, ["remote", "get-url", "origin"]);
    return result.exitCode === 0 ? result.stdout : undefined;
}

export interface RemoteResult {
    action: "added" | "updated";
    url: string;
}

/** Point the store's `origin` at `url`, creating or updating it. The store (and its repo) is scaffolded first if needed. */
export async function setStoreRemote(url: string, root = storeRoot()): Promise<RemoteResult> {
    await ensureStoreScaffold(root);
    const existing = await runGit(root, ["remote", "get-url", "origin"]);

    if (existing.exitCode === 0) {
        const update = await runGit(root, ["remote", "set-url", "origin", url]);

        if (update.exitCode !== 0) {
            throw new Error(`git remote set-url failed: ${update.stderr}`);
        }

        return { action: "updated", url };
    }

    const add = await runGit(root, ["remote", "add", "origin", url]);

    if (add.exitCode !== 0) {
        throw new Error(`git remote add failed: ${add.stderr}`);
    }

    return { action: "added", url };
}

/**
 * Stage everything and commit, quietly doing nothing when the tree is clean
 * or the store is not a repo. Mutating verbs (create/regen/rename/tag/rm)
 * call this so the store's history tracks every shape change; `run` does not,
 * because run-counter churn is not history worth keeping per-commit.
 */
export async function commitStore(message: string, root = storeRoot()): Promise<void> {
    if (!(await pathExists(join(root, ".git")))) {
        return;
    }

    // Never stage the credential-bearing cache (or trash). The .gitignore
    // covers a fresh repo, but a pre-existing repo or a hand-damaged ignore
    // file must not let `registry.json` slip into pushable history: unstage
    // anything already sitting in the index (a pre-staged file would ride the
    // allowlisted commit otherwise), stage an explicit allowlist, and
    // proactively untrack cache/trash if they ever got committed. The reset
    // may fail on an unborn branch, where nothing can be pre-staged wrongly.
    await runGit(root, ["reset", "-q"]);
    await runGit(root, ["rm", "-r", "--cached", "--ignore-unmatch", "-q", "cache", "trash", "node_modules"]);
    await runGit(root, ["add", "-A", "--", ".gitignore", "package.json", "tsconfig.json", "persisted"]);
    // Inspect the INDEX, not the worktree: stray untracked files outside the
    // allowlist would make a whole-tree status non-empty while nothing is
    // staged, and the commit would then fail with "no changes added".
    const staged = await runGit(root, ["diff", "--cached", "--name-only"]);

    if (staged.exitCode !== 0 || staged.stdout === "") {
        return;
    }

    // A machine without a git identity must not make commits fail; the
    // fallback identity applies only when none is configured. Signing and
    // hooks are disabled outright: this is an internal machine-managed repo,
    // and a global commit.gpgsign=true or core.hooksPath must not block it.
    const identity = await runGit(root, ["config", "user.email"]);
    const identityArgs =
        identity.stdout === ""
            ? ["-c", "user.name=genesis-scripts", "-c", "user.email=scripts@genesis-tools.local"]
            : [];
    const commit = await runGit(root, [
        ...identityArgs,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-verify",
        "-m",
        message,
    ]);

    if (commit.exitCode !== 0) {
        logger.warn({ root, message, stderr: commit.stderr }, "script store commit failed");
        return;
    }

    logger.debug({ root, message }, "script store committed");

    // Opt-in follow-through: with `tools scripts remote <url> --auto-push on`,
    // every store commit lands on the remote too. A failed push never fails
    // the verb that triggered it.
    const config = await readStoreConfig(root);

    if (config.remote?.autoPush && !config.remote.declined) {
        const push = await runGit(root, ["push", "origin", "HEAD"]);

        if (push.exitCode !== 0) {
            logger.warn({ root, stderr: push.stderr }, "store auto-push failed");
            ui.warn(`store auto-push failed: ${push.stderr.split("\n")[0]}`);
        } else {
            logger.debug({ root }, "store auto-pushed");
        }
    }
}

/**
 * Write the store scaffolding (tsconfig alias + package.json + local git
 * repo) when missing.
 *
 * The tsconfig is rewritten whenever its mapping no longer points at THIS
 * checkout, so a moved repo heals on the next `tools scripts` invocation.
 * package.json is only ever created, never overwritten: the user may have
 * added script-local deps.
 */
export async function ensureStoreScaffold(root = storeRoot()): Promise<void> {
    await mkdir(persistedDir(root), { recursive: true });

    const tsconfigPath = join(root, "tsconfig.json");
    const wanted = {
        compilerOptions: {
            paths: {
                "@gt/scripts/*": [join(LIB_DIR, "*")],
                // chrome-devtools scaffold recipes import the cdp lib this way
                "@gt/chrome-devtools/*": [join(LIB_DIR, "..", "..", "chrome-devtools", "lib", "*")],
            },
        },
    };
    const existing = await Bun.file(tsconfigPath)
        .text()
        .catch(() => undefined);
    const wantedText = `${SafeJSON.stringify(wanted, { strict: true }, 2)}\n`;

    if (existing !== wantedText) {
        atomicWriteFileSync(tsconfigPath, wantedText);
        logger.debug({ tsconfigPath, libDir: LIB_DIR }, "scripts store tsconfig written");
    }

    const packagePath = join(root, "package.json");

    if (!(await Bun.file(packagePath).exists())) {
        atomicWriteFileSync(packagePath, `${SafeJSON.stringify(STORE_PACKAGE_JSON, { strict: true }, 2)}\n`);
        logger.debug({ packagePath }, "scripts store package.json written");
    }

    await ensureStoreGit(root);
}

/** True when the store's node_modules is missing, i.e. `bun install` is due. */
export async function storeDepsMissing(root = storeRoot()): Promise<boolean> {
    return !(await Bun.file(join(root, "node_modules", "commander", "package.json")).exists());
}

/**
 * Install store deps when missing. Persisted scripts import commander and
 * picocolors from the store's own node_modules; without this a freshly
 * migrated machine fails with "Cannot find module 'commander'".
 */
export async function ensureStoreDeps(root = storeRoot()): Promise<void> {
    if (!(await storeDepsMissing(root))) {
        return;
    }

    logger.info({ root }, "installing script store dependencies");
    const proc = Bun.spawn(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    // Drain both pipes WHILE waiting: a chatty install that fills the pipe
    // buffer would otherwise block the child and hang `run` forever.
    const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
    ]);

    if (exitCode !== 0) {
        throw new Error(`bun install failed in ${root}: ${stderr.trim().slice(0, 500)}`);
    }
}
