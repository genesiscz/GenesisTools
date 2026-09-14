import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import type { Command } from "commander";
import { runLogin } from "../../lib/accounts/run-login";

interface LoginFlags {
    provider?: string | true;
    home?: string;
    authFile?: string;
    importNative?: boolean;
    broker?: boolean;
}

/**
 * Whether this provider can bind a credential FILE at all.
 *
 * `runLogin` already refuses `--home` / `--auth-file` / `--import-native` on a provider whose
 * credential has no `authFile` field, naming the provider. Asking the same question here is
 * what stops the flag being OFFERED in `--help` on a door where it can only ever error —
 * anthropic logs in through OAuth and has no file to bind.
 */
function bindsCredentialFiles(provider: string | undefined): boolean {
    if (!provider) {
        return true;
    }

    registerBuiltInPlugins();

    return providerPlugin(provider).credential.fields.includes("authFile");
}

export function registerAccountLoginCommand(
    program: Command,
    opts: {
        provider?: string;
        tool: string;
        subcommand: string[];
        /** One line for `--help`; the provider-neutral door keeps the generic wording. */
        description?: string;
    }
): void {
    const login = program
        .command("login [name]")
        .description(opts.description ?? "Log in to a subscription account, storing the grant in the shared vault");

    if (bindsCredentialFiles(opts.provider)) {
        login
            .option("--home <dir>", "Explicit vendor home for native credential-file login")
            .option("--auth-file <file>", "Bind an existing credential file instead of running OAuth")
            .option("--import-native", "Bind the current native CLI credential file; fail if it does not exist");
    }

    // `--broker` is a codex-only compatibility spelling of the default. Declared everywhere it
    // could be typed, hidden everywhere it is not codex's own door.
    login.addOption(
        login
            .createOption("--broker", "Codex compatibility alias for the default separate vault login")
            .hideHelp(opts.provider !== undefined && opts.provider !== "openai-sub")
    );

    if (!opts.provider) {
        login.option(
            "--provider [value]",
            `Provider: ${ACCOUNT_PROVIDER_ALIASES.join(", ")} (plugin ids also accepted)`
        );
    }

    login.action(async (name: string | undefined, flags: LoginFlags) => {
        await runLogin({
            provider: opts.provider ?? flags.provider,
            name,
            home: flags.home,
            authFile: flags.authFile,
            importNative: flags.importNative,
            codexBroker: flags.broker,
            tool: opts.tool,
            subcommand: opts.subcommand,
        });
    });
}

export function registerAiProviderLoginCommands(program: Command): void {
    const codex = program.command("codex").description("Codex subscription account commands");
    registerAccountLoginCommand(codex, {
        provider: "openai-sub",
        tool: "tools ai codex login",
        subcommand: ["codex", "login"],
    });
}
