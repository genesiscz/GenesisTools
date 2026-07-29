import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import {
    AccountInUseError,
    type AddAccountInput,
    addAccount,
    editAccount,
    removeAccount,
    type SecretCredentialField,
    testAccount,
} from "@genesiscz/utils/ai/config/account-ops";
import type { AccountEntry, UseEnvApiKey } from "@genesiscz/utils/ai/config/schema";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { allProviderPlugins, providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { redactSecrets } from "@genesiscz/utils/security";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    renderCliSection,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { credentialSourceOf, printAccountTable, printReferrerTable } from "./display";
import { readStdinValue } from "./stdin";

/**
 * `tools ai config account ...` — thin controllers over `account-ops`. Nothing
 * here knows how an account is stored; it parses flags, asks questions when a
 * TTY is present, and renders.
 */

interface AddFlags {
    provider?: string;
    name?: string;
    label?: string;
    tag?: string[];
    endpoint?: string;
    billing?: string;
    apiKeyStdin?: boolean;
    useEnv?: string;
    authFile?: string;
    dataDir?: string;
    json?: boolean;
}

interface EditFlags {
    enable?: boolean;
    disable?: boolean;
    label?: string;
    tag?: string[];
    rename?: string;
    endpoint?: string;
    useEnv?: string;
    authFile?: string;
    dataDir?: string;
}

/** `--use-env A,B` names variables; `true`/`false` switch the provider defaults on and off. */
export function parseUseEnv(value: string): UseEnvApiKey {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "all") {
        return true;
    }

    if (normalized === "false" || normalized === "off" || normalized === "none") {
        return false;
    }

    const names = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

    if (names.length === 0) {
        throw new Error("--use-env needs variable names (comma-separated), or true/false.");
    }

    return names;
}

function parseBilling(value: string): AccountEntry["billing"]["mode"] {
    if (value === "subscription" || value === "metered" || value === "free") {
        return value;
    }

    throw new Error(`--billing must be subscription, metered or free (got "${value}").`);
}

async function requireStore(): Promise<AiConfigStore> {
    return AiConfigStore.load();
}

function pluginOptions(): Array<{ value: string; label: string; hint: string }> {
    return allProviderPlugins()
        .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)))
        .map((plugin) => ({
            value: plugin.id,
            label: `${plugin.id}`,
            hint: `${plugin.kind} · ${[...plugin.capabilities].join(", ")}`,
        }));
}

/** Gateways and self-hosted runtimes live at a URL the credential spec cannot describe. */
function wantsEndpoint(plugin: ProviderPlugin): boolean {
    return plugin.kind === "gateway" || plugin.kind === "local";
}

async function collectInteractively(flags: AddFlags): Promise<AddAccountInput> {
    const provider = flags.provider ?? String(await p.select({ message: "Provider:", options: pluginOptions() }));
    const plugin = providerPlugin(provider);
    const name =
        flags.name ??
        (await p.text({
            message: "Account name:",
            placeholder: `${provider}-main`,
            validate: (value) => (value.trim().length === 0 ? "A name is required" : undefined),
        }));

    const input: AddAccountInput = { provider, name: name.trim(), secrets: {} };

    if (flags.label) {
        input.label = flags.label;
    }

    if (flags.tag?.length) {
        input.tags = flags.tag;
    }

    if (flags.billing) {
        input.billing = parseBilling(flags.billing);
    }

    if (flags.useEnv) {
        input.useEnvApiKey = parseUseEnv(flags.useEnv);
    }

    for (const field of plugin.credential.fields) {
        if (field === "authFile" || field === "dataDir") {
            const preset = field === "authFile" ? flags.authFile : flags.dataDir;
            const value =
                preset ??
                (await p.text({ message: `${field} path (leave empty to skip):`, placeholder: "~/.grok/auth.json" }));

            if (value.trim().length > 0) {
                input[field] = value.trim();
            }

            continue;
        }

        const secretField: SecretCredentialField = field;
        const secret = await p.password({ message: `${field} (hidden, stored in the vault):` });
        if (secret.trim().length > 0) {
            input.secrets = { ...input.secrets, [secretField]: secret.trim() };
        }
    }

    if (wantsEndpoint(plugin)) {
        const endpoint =
            flags.endpoint ??
            (await p.text({
                message: "Endpoint URL (leave empty for the provider default):",
                placeholder: "http://127.0.0.1:11434",
            }));

        if (endpoint.trim().length > 0) {
            input.endpoint = endpoint.trim();
        }
    } else if (flags.endpoint) {
        input.endpoint = flags.endpoint;
    }

    return input;
}

function fromFlags(flags: AddFlags, apiKey: string | undefined): AddAccountInput {
    if (!flags.provider || !flags.name) {
        throw new Error("--provider and --name are required when not running interactively.");
    }

    const input: AddAccountInput = { provider: flags.provider, name: flags.name };

    if (apiKey) {
        input.secrets = { apiKey };
    }

    if (flags.label) {
        input.label = flags.label;
    }

    if (flags.tag?.length) {
        input.tags = flags.tag;
    }

    if (flags.endpoint) {
        input.endpoint = flags.endpoint;
    }

    if (flags.billing) {
        input.billing = parseBilling(flags.billing);
    }

    if (flags.useEnv) {
        input.useEnvApiKey = parseUseEnv(flags.useEnv);
    }

    if (flags.authFile) {
        input.authFile = flags.authFile;
    }

    if (flags.dataDir) {
        input.dataDir = flags.dataDir;
    }

    return input;
}

async function reportAdded(input: AddAccountInput, json: boolean | undefined): Promise<void> {
    const account = await addAccount(input);

    if (json) {
        out.result(redactSecrets(account));
        return;
    }

    out.log.success(`Added ${pc.bold(account.name)} (${account.id}) for ${account.provider}.`);
    out.log.info(`Verify it with: tools ai config account test ${account.name}`);
}

/**
 * The prompt-driven add.
 *
 * Separate from `cmdAccountAdd` because the TUI has already passed the TTY gate
 * before it gets here; re-asking `isInteractive()` inside would be a second
 * guard that can only ever disagree with the first.
 */
export async function addAccountInteractive(flags: AddFlags = {}): Promise<void> {
    await reportAdded(await collectInteractively(flags), flags.json);
}

export async function cmdAccountAdd(flags: AddFlags): Promise<void> {
    const apiKey = flags.apiKeyStdin ? await readStdinValue() : undefined;

    if (flags.apiKeyStdin && !apiKey) {
        throw new Error("--api-key-stdin was passed but stdin was empty.");
    }

    const interactive = isInteractive() && !(flags.provider && flags.name);

    if (!interactive && (!flags.provider || !flags.name)) {
        out.log.error("--provider and --name are required in non-interactive mode.");
        out.log.info(
            suggestCommand("tools ai config account add", {
                subcommand: ["config", "account", "add"],
                add: ["--provider", "<id>", "--name", "<name>", "--api-key-stdin"],
            })
        );
        process.exitCode = 1;
        return;
    }

    const input = interactive ? await collectInteractively(flags) : fromFlags(flags, apiKey);
    if (apiKey && !input.secrets?.apiKey) {
        input.secrets = { ...input.secrets, apiKey };
    }

    await reportAdded(input, flags.json);
}

export async function cmdAccountList(flags: {
    json?: boolean;
    provider?: string;
    enabledOnly?: boolean;
}): Promise<void> {
    const store = await requireStore();
    const accounts = store.accounts({
        ...(flags.provider ? { provider: flags.provider } : {}),
        ...(flags.enabledOnly ? { enabled: true } : {}),
    });

    if (flags.json) {
        out.result(accounts.map((account) => redactSecrets(account)));
        return;
    }

    if (accounts.length === 0) {
        out.log.info("No AI accounts configured yet.");
        out.log.info(suggestCommand("tools ai config account add", { subcommand: ["config", "account", "list"] }));
        return;
    }

    renderCliHeader("AI Accounts", `${accounts.length} configured`);
    printAccountTable(accounts);
    renderCliSection("Columns");
    renderCliKeyRow("CRED", "where the credential lives, read from the config shape (no secret is decrypted)");
    renderCliKeyRow("KIND", "provider plugin kind: api-key, subscription, local or gateway");
}

export async function cmdAccountShow(idOrName: string, flags: { json?: boolean }): Promise<void> {
    const store = await requireStore();
    const account = store.account(idOrName);

    if (!account) {
        out.log.error(`No AI account matches "${idOrName}".`);
        process.exitCode = 1;
        return;
    }

    // redactSecrets masks literal values and leaves SecureRefs intact, which is
    // exactly right: a vault path tells the user where the credential lives and
    // reveals nothing.
    const safe = redactSecrets(account);

    if (flags.json) {
        out.result(safe);
        return;
    }

    renderCliHeader(account.name, `${account.provider} · ${account.id}`);
    renderCliSection("Account");
    renderCliKeyRow("id", account.id, 14);
    renderCliKeyRow("provider", account.provider, 14);
    renderCliKeyRow("enabled", account.enabled ? "yes" : "no", 14);
    renderCliKeyRow(
        "billing",
        account.billing.plan ? `${account.billing.mode} (${account.billing.plan})` : account.billing.mode,
        14
    );
    renderCliKeyRow("label", account.label ?? "—", 14);
    renderCliKeyRow("tags", account.tags?.join(", ") ?? "—", 14);
    renderCliKeyRow("endpoint", account.endpoint ?? "—", 14);
    renderCliKeyRow("useEnvApiKey", SafeJSON.stringify(account.useEnvApiKey), 14);
    renderCliKeyRow("credential", credentialSourceOf(account), 14);

    renderCliSection("Credentials (values never resolved)");
    const table = createBoxTable(["FIELD", "STORED AS"]);
    for (const [field, value] of Object.entries(safe.credentials)) {
        if (value === undefined) {
            continue;
        }

        const shown =
            typeof value === "object" && value !== null && "path" in value
                ? pc.green(`vault:${String((value as { path: string }).path)}`)
                : pc.dim(typeof value === "string" ? value : SafeJSON.stringify(value));
        table.push([field, shown]);
    }

    out.println(table.toString());

    const referrers = await store.referrers(account.id);
    if (referrers.length > 0) {
        renderCliSection(`Referenced by ${referrers.length}`);
        printReferrerTable(referrers, new Set(store.accounts().map((entry) => entry.id)));
    }
}

export async function cmdAccountEdit(idOrName: string, flags: EditFlags): Promise<void> {
    if (flags.enable && flags.disable) {
        throw new Error("--enable and --disable are mutually exclusive.");
    }

    const account = await editAccount(idOrName, {
        ...(flags.enable ? { enabled: true } : {}),
        ...(flags.disable ? { enabled: false } : {}),
        ...(flags.label !== undefined ? { label: flags.label } : {}),
        ...(flags.tag !== undefined ? { tags: flags.tag } : {}),
        ...(flags.rename !== undefined ? { rename: flags.rename } : {}),
        ...(flags.endpoint !== undefined ? { endpoint: flags.endpoint } : {}),
        ...(flags.useEnv !== undefined ? { useEnvApiKey: parseUseEnv(flags.useEnv) } : {}),
        ...(flags.authFile !== undefined ? { authFile: flags.authFile } : {}),
        ...(flags.dataDir !== undefined ? { dataDir: flags.dataDir } : {}),
    });

    out.log.success(`Updated ${pc.bold(account.name)} (${account.id}).`);
}

export async function cmdAccountRm(idOrName: string, flags: { force?: boolean }): Promise<void> {
    try {
        const result = await removeAccount(idOrName, { force: flags.force });
        out.log.success(
            `Removed ${pc.bold(result.account.name)} (${result.account.id}); deleted ${result.secretsDeleted.length} vault entr${
                result.secretsDeleted.length === 1 ? "y" : "ies"
            }.`
        );

        if (result.referrers.length > 0) {
            out.log.warn(`${result.referrers.length} reference(s) now dangle. Run: tools ai config doctor`);
        }
    } catch (err) {
        if (!(err instanceof AccountInUseError)) {
            throw err;
        }

        out.log.error(`"${err.account.name}" is still referenced; refusing to remove it.`);
        printReferrerTable(err.referrers);
        out.log.info(`Re-run with --force to remove it and leave those references dangling.`);
        process.exitCode = 1;
    }
}

export async function cmdAccountTest(idOrName: string, flags: { live?: boolean; json?: boolean }): Promise<void> {
    const result = await testAccount(idOrName, { live: flags.live });

    if (flags.json) {
        out.result({
            account: result.account.name,
            ok: result.ok,
            credential: result.credential,
            health: result.health,
            binding: result.binding,
        });
        return;
    }

    renderCliHeader(`Test ${result.account.name}`, result.account.provider);
    const table = createBoxTable(["CHECK", "STATUS", "DETAIL"]);
    table.push([
        "credential",
        formatDotStatus(result.credential.ok ? "ok" : "err", result.credential.ok ? "ok" : "fail"),
        result.credential.detail,
    ]);
    table.push([
        "binding",
        formatDotStatus(result.binding.ok ? "ok" : "err", result.binding.ok ? "ok" : "fail"),
        result.binding.detail,
    ]);

    if (result.health) {
        table.push([
            "health",
            formatDotStatus(result.health.ok ? "ok" : "err", result.health.ok ? "ok" : "fail"),
            result.health.detail,
        ]);
    } else {
        table.push([
            "health",
            formatDotStatus("dim", "skipped"),
            flags.live ? "plugin declares no probe" : "pass --live to probe",
        ]);
    }

    out.println(table.toString());

    if (!result.ok) {
        process.exitCode = 1;
    }
}

export function registerAccountCommands(config: Command): void {
    const account = config.command("account").description("Add, inspect, edit, test and remove AI accounts");

    account
        .command("add")
        .description("Add an account; secrets go straight into the vault")
        .option("--provider <id>", "Provider plugin id (see: tools ai config account add --help)")
        .option("--name <name>", "Human handle for the account")
        .option("--label <label>", "Display label")
        .option("--tag <tag>", "Tag (repeatable)", (value: string, previous: string[] = []) => [...previous, value])
        .option("--endpoint <url>", "Base URL for gateway/self-hosted providers")
        .option("--billing <mode>", "subscription | metered | free (default: from the plugin kind)")
        .option("--api-key-stdin", "Read the API key from stdin (never from argv)")
        .option("--use-env <vars>", "Comma-separated env vars this account may fall back to, or true/false")
        .option("--auth-file <path>", "Path to a subscription CLI's auth file")
        .option("--data-dir <path>", "Path to a provider data directory")
        .option("--json", "Emit the created account as JSON")
        .action(async (flags: AddFlags) => {
            await cmdAccountAdd(flags);
        });

    account
        .command("list")
        .description("List configured accounts")
        .option("--provider <id>", "Only accounts of this provider")
        .option("--enabled-only", "Hide disabled accounts")
        .option("--json", "Emit JSON (secrets redacted)")
        .action(async (flags: { json?: boolean; provider?: string; enabledOnly?: boolean }) => {
            await cmdAccountList(flags);
        });

    account
        .command("show")
        .description("Show one account; secret values are never resolved")
        .argument("<idOrName>", "Account id or name")
        .option("--json", "Emit JSON (secrets redacted)")
        .action(async (idOrName: string, flags: { json?: boolean }) => {
            await cmdAccountShow(idOrName, flags);
        });

    account
        .command("edit")
        .description("Change an account's metadata or env-fallback policy")
        .argument("<idOrName>", "Account id or name")
        .option("--enable", "Enable the account")
        .option("--disable", "Disable the account")
        .option("--label <label>", "Set the display label")
        .option(
            "--tag <tag>",
            "Tag (repeatable; replaces the existing set)",
            (value: string, previous: string[] = []) => [...previous, value]
        )
        .option("--rename <newName>", "Rename it; the id and every reference stay valid")
        .option("--endpoint <url>", "Set the base URL")
        .option("--use-env <vars>", "Comma-separated env vars to allow, or true/false")
        .option("--auth-file <path>", "Path to a subscription CLI's auth file")
        .option("--data-dir <path>", "Path to a provider data directory")
        .action(async (idOrName: string, flags: EditFlags) => {
            await cmdAccountEdit(idOrName, flags);
        });

    account
        .command("rm")
        .description("Remove an account and its vault entries")
        .argument("<idOrName>", "Account id or name")
        .option("--force", "Remove even while something still references it")
        .action(async (idOrName: string, flags: { force?: boolean }) => {
            await cmdAccountRm(idOrName, flags);
        });

    account
        .command("test")
        .description("Resolve the credential and bind the provider")
        .argument("<idOrName>", "Account id or name")
        .option("--live", "Also run the plugin's health probe (may touch the network)")
        .option("--json", "Emit JSON")
        .action(async (idOrName: string, flags: { live?: boolean; json?: boolean }) => {
            await cmdAccountTest(idOrName, flags);
        });
}
