import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { embedAccountEnvVar } from "@genesiscz/utils/ai/account-env";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger } from "@genesiscz/utils/logger";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

const { log } = logger.scoped("t3:launchers");

/** Where launchers go unless `--bin-dir` says otherwise. */
export function defaultBinDir(): string {
    return genesisToolsDir("bin");
}

/** One launcher file: the env-driven one (`account` null) or a per-account one. */
export interface LauncherSpec {
    alias: HarnessId;
    /** The account it pins, or null for the launcher that reads `TOOLS_<ALIAS>_EMBED_ACCOUNT` from its environment. */
    account: string | null;
}

/** The file name of an account inside a launcher name: unsafe characters become `-`. */
export function accountFileSlug(account: string): string {
    return account.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function launcherFileName(spec: LauncherSpec): string {
    const base = `${spec.alias}-tools`;

    return spec.account === null ? base : `${base}@${accountFileSlug(spec.account)}`;
}

export function launcherPath(binDir: string, spec: LauncherSpec): string {
    return join(binDir, launcherFileName(spec));
}

/** The launcher script. The exec line is the one `parseLauncherCheckout` reads back. */
export function renderLauncher(input: { spec: LauncherSpec; checkout: string }): string {
    const { spec, checkout } = input;
    const lines = [
        "#!/bin/zsh",
        `# ${spec.alias} for apps that embed it (T3 Code). Written by ${toolCommand("t3 launchers install")}; rewrite it with that command.`,
        'export PATH="$HOME/.bun/bin:$PATH"',
    ];

    if (spec.account !== null) {
        lines.push(`export ${embedAccountEnvVar(spec.alias)}=${shellQuote(spec.account)}`);
    }

    lines.push(`exec ${shellQuote(join(checkout, "tools"))} ${spec.alias} embed -- "$@"`);

    return `${lines.join("\n")}\n`;
}

/** The checkout a launcher execs, or null when the file was not written by `renderLauncher`. */
export function parseLauncherCheckout(script: string): string | null {
    const match = script.match(/^exec '((?:[^']|'\\'')*)' \S+ embed -- "\$@"$/m);

    if (!match) {
        return null;
    }

    const toolsPath = match[1].replace(/'\\''/g, "'");

    return dirname(toolsPath);
}

/** True when `dir` holds a runnable `tools` entry point. */
export function isCheckout(dir: string): boolean {
    const tools = join(dir, "tools");

    try {
        accessSync(tools, constants.X_OK);
        return statSync(tools).isFile();
    } catch (error) {
        log.debug({ dir, error }, "not a GenesisTools checkout");
        return false;
    }
}

/** True when `dir` is a linked git worktree: its `.git` is a pointer file, not a folder. */
export function isLinkedWorktree(dir: string): boolean {
    const dotGit = join(dir, ".git");

    return existsSync(dotGit) && statSync(dotGit).isFile();
}

/**
 * The checkout whose `tools` is on PATH (the main checkout). A worktree is refused: a launcher outlives the worktree,
 * so the caller must name a worktree explicitly with `--checkout`.
 */
export function defaultCheckout(): string {
    const onPath = Bun.which("tools");

    if (!onPath) {
        throw new Error("No `tools` on PATH. Pass --checkout <GenesisTools checkout>.");
    }

    const checkout = dirname(realpathSync(onPath));
    log.debug({ onPath, checkout }, "default checkout from PATH");

    if (!isCheckout(checkout)) {
        throw new Error(`\`tools\` on PATH (${onPath}) is not inside a GenesisTools checkout. Pass --checkout <dir>.`);
    }

    if (isLinkedWorktree(checkout)) {
        throw new Error(
            `\`tools\` on PATH resolves to the worktree ${checkout}. Pass --checkout <dir> to use a worktree on purpose.`
        );
    }

    return checkout;
}

export type LauncherWriteStatus = "created" | "updated" | "unchanged";

export interface LauncherWriteResult {
    path: string;
    spec: LauncherSpec;
    status: LauncherWriteStatus;
}

/** Writes one launcher. The same content is a no-op, apart from restoring mode 755. */
export function writeLauncher(input: { binDir: string; spec: LauncherSpec; checkout: string }): LauncherWriteResult {
    const path = launcherPath(input.binDir, input.spec);
    const content = renderLauncher({ spec: input.spec, checkout: input.checkout });
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;

    if (current === content) {
        if ((statSync(path).mode & 0o777) !== 0o755) {
            chmodSync(path, 0o755);
        }

        return { path, spec: input.spec, status: "unchanged" };
    }

    atomicWriteFileSync(path, content, { mode: 0o755 });
    log.debug({ path, checkout: input.checkout, account: input.spec.account }, "launcher written");

    return { path, spec: input.spec, status: current === null ? "created" : "updated" };
}

/** Every env-driven launcher, plus one per `--account <alias>:<name>`. */
export function installLaunchers(input: {
    binDir: string;
    checkout: string;
    accounts: readonly LauncherSpec[];
}): LauncherWriteResult[] {
    const specs: LauncherSpec[] = [
        ...ACCOUNT_PROVIDER_ALIASES.map((alias) => ({ alias, account: null })),
        ...input.accounts,
    ];

    return specs.map((spec) => writeLauncher({ binDir: input.binDir, spec, checkout: input.checkout }));
}

/** `<alias>:<name>` from `--account`. */
export function parseAccountLauncherFlag(value: string): LauncherSpec {
    const colon = value.indexOf(":");
    const alias = colon < 0 ? "" : value.slice(0, colon);
    const account = colon < 0 ? "" : value.slice(colon + 1).trim();
    const known = ACCOUNT_PROVIDER_ALIASES.find((candidate) => candidate === alias);

    if (!known || account === "") {
        throw new Error(
            `--account takes <alias>:<account> with alias one of ${ACCOUNT_PROVIDER_ALIASES.join(", ")} (got "${value}").`
        );
    }

    return { alias: known, account };
}

/** The per-account launchers already in `binDir` for one alias (file names only). */
export function listAccountLaunchers(binDir: string, alias: HarnessId): string[] {
    if (!existsSync(binDir)) {
        return [];
    }

    const prefix = `${alias}-tools@`;

    return readdirSync(binDir)
        .filter((name) => name.startsWith(prefix))
        .sort();
}
