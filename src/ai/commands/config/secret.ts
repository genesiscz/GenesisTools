import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import {
    exportVault,
    importVault,
    isSecretPath,
    recordVaultExport,
    rotateMasterKey,
    secrets,
} from "@genesiscz/utils/security";
import { createBoxTable, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { readStdinValue } from "./stdin";

/**
 * `tools ai config secret ...` — the vault's human surface.
 *
 * One rule shapes every command here: a secret value never appears on argv.
 * argv lands in shell history and in every `ps` on the machine, so values come
 * from stdin or a hidden prompt, and a value passed as an argument is a hard
 * error rather than something quietly accepted.
 */

const MIN_PASSPHRASE = 8;

async function readPassphrase(options: {
    purpose: string;
    passphraseEnv?: string;
    confirm?: boolean;
}): Promise<string> {
    if (options.passphraseEnv) {
        // Trimmed on purpose: a passphrase exported from a shell almost always
        // carries a trailing newline, and a silent mismatch on import is unfixable.
        const value = env.getTrimmed(options.passphraseEnv);
        if (!value) {
            throw new Error(`${options.passphraseEnv} is not set (or is empty), so no passphrase could be read.`);
        }

        return value;
    }

    if (!isInteractive()) {
        throw new Error(
            `A passphrase is required to ${options.purpose} and this process has no TTY. Pass --passphrase-env <VAR> naming an environment variable that holds it.`
        );
    }

    const passphrase = await p.password({
        message: `Passphrase (${options.purpose}):`,
        validate: (value) =>
            value.length < MIN_PASSPHRASE ? `At least ${MIN_PASSPHRASE} characters` : undefined,
    });

    if (options.confirm) {
        const again = await p.password({ message: "Repeat the passphrase:" });
        if (again !== passphrase) {
            throw new Error("The two passphrases do not match.");
        }
    }

    return passphrase;
}

export async function cmdSecretSet(path: string, value: string | undefined, flags: { stdin?: boolean }): Promise<void> {
    if (value !== undefined) {
        out.log.error("Refusing a secret passed as an argument: argv is visible in shell history and in `ps`.");
        out.log.info(`Pipe it instead: echo -n '<value>' | tools ai config secret set ${path} --stdin`);
        process.exitCode = 1;
        return;
    }

    if (!isSecretPath(path)) {
        throw new Error(`Invalid secret path "${path}". Expected <domain>/<name>[/<name>...], e.g. ai/acc_xai/apiKey.`);
    }

    let secret: string | undefined;

    if (flags.stdin) {
        secret = await readStdinValue();
        if (!secret) {
            throw new Error("--stdin was passed but stdin was empty.");
        }
    } else {
        if (!isInteractive()) {
            out.log.error("A secret value needs a hidden prompt, which needs a TTY.");
            out.log.info(suggestCommand("tools ai config secret set", { add: ["--stdin"] }));
            process.exitCode = 1;
            return;
        }

        secret = await p.password({
            message: `Value for ${path} (hidden):`,
            validate: (input) => (input.trim().length === 0 ? "A value is required" : undefined),
        });
    }

    const store = await secrets();
    await store.set(path, secret.trim());
    out.log.success(`Stored ${pc.bold(path)} in the vault.`);
}

export async function cmdSecretLs(prefix: string | undefined, flags: { json?: boolean }): Promise<void> {
    const store = await secrets();
    const paths = await store.list(prefix);

    if (flags.json) {
        out.result(paths);
        return;
    }

    if (paths.length === 0) {
        out.log.info(prefix ? `No vault entries under "${prefix}".` : "The vault is empty.");
        return;
    }

    renderCliHeader("Vault entries", `${paths.length} paths${prefix ? ` under ${prefix}` : ""}`);
    const table = createBoxTable(["PATH"]);
    for (const path of paths) {
        table.push([pc.white(path)]);
    }

    out.println(table.toString());
    renderCliSection("Note");
    out.log.info("Paths only. Values are never printed, and reading one is not something this command does.");
}

export async function cmdSecretRotate(flags: { yes?: boolean }): Promise<void> {
    if (!flags.yes) {
        if (!isInteractive()) {
            out.log.error("Rotation rewrites every vault entry under a new key; confirm it explicitly.");
            out.log.info(suggestCommand("tools ai config secret rotate", { add: ["--yes"] }));
            process.exitCode = 1;
            return;
        }

        const confirmed = await p.confirm({
            message: "Re-encrypt every vault entry under a freshly generated master key?",
            initialValue: false,
            danger: true,
        });

        if (!confirmed) {
            out.log.info("Rotation cancelled; nothing changed.");
            return;
        }
    }

    const { rotated } = await rotateMasterKey();
    out.log.success(`Rotated the master key and re-encrypted ${rotated} entr${rotated === 1 ? "y" : "ies"}.`);
    out.log.warn("Any vault export taken before now still decrypts with its own passphrase; it is unaffected.");
}

export async function cmdSecretExport(flags: { out: string; passphraseEnv?: string }): Promise<void> {
    const passphrase = await readPassphrase({
        purpose: "encrypt the export",
        passphraseEnv: flags.passphraseEnv,
        confirm: true,
    });

    const blob = await exportVault(passphrase);
    const target = resolve(flags.out);

    writeFileSync(target, blob, { mode: 0o600 });
    chmodSync(target, 0o600);
    await recordVaultExport();

    out.log.success(`Wrote the encrypted vault export to ${pc.bold(target)} (mode 0600).`);
    out.log.warn("Keep it somewhere the machine's keychain cannot take with it. Without it, a lost key is final.");
}

export async function cmdSecretImport(file: string, flags: { passphraseEnv?: string }): Promise<void> {
    const source = resolve(file);
    const blob = readFileSync(source, "utf8");
    const passphrase = await readPassphrase({ purpose: "decrypt the export", passphraseEnv: flags.passphraseEnv });

    const { imported } = await importVault(blob, passphrase);
    out.log.success(`Imported ${imported} secret${imported === 1 ? "" : "s"} from ${source}.`);
}

export function registerSecretCommands(config: Command): void {
    const secret = config.command("secret").description("The encrypted vault behind every stored credential");

    secret
        .command("set")
        .description("Store a secret; the value comes from stdin or a hidden prompt, never from argv")
        .argument("<path>", "Vault path, e.g. ai/acc_xai/apiKey")
        .argument("[value]", "Not accepted — passing a secret on argv is refused")
        .option("--stdin", "Read the value from stdin")
        .action(async (path: string, value: string | undefined, flags: { stdin?: boolean }) => {
            await cmdSecretSet(path, value, flags);
        });

    secret
        .command("ls")
        .description("List vault paths (never values)")
        .argument("[prefix]", "Only paths starting with this prefix")
        .option("--json", "Emit JSON")
        .action(async (prefix: string | undefined, flags: { json?: boolean }) => {
            await cmdSecretLs(prefix, flags);
        });

    secret
        .command("rotate")
        .description("Generate a new master key and re-encrypt every entry")
        .option("--yes", "Skip the confirmation (required without a TTY)")
        .action(async (flags: { yes?: boolean }) => {
            await cmdSecretRotate(flags);
        });

    secret
        .command("export")
        .description("Write a passphrase-protected copy of every secret")
        .requiredOption("--out <file>", "Where to write the encrypted export")
        .option("--passphrase-env <VAR>", "Read the passphrase from this environment variable (required without a TTY)")
        .action(async (flags: { out: string; passphraseEnv?: string }) => {
            await cmdSecretExport(flags);
        });

    secret
        .command("import")
        .description("Restore an export into this machine's vault")
        .argument("<file>", "The encrypted export to read")
        .option("--passphrase-env <VAR>", "Read the passphrase from this environment variable (required without a TTY)")
        .action(async (file: string, flags: { passphraseEnv?: string }) => {
            await cmdSecretImport(file, flags);
        });
}
