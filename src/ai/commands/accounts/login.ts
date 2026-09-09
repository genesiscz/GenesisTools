import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import type { Command } from "commander";
import { runLogin } from "../../lib/accounts/run-login";

interface LoginFlags {
    provider?: string | true;
    home?: string;
    authFile?: string;
    importNative?: boolean;
    broker?: boolean;
}

export function registerAccountLoginCommand(
    program: Command,
    opts: {
        provider?: string;
        tool: string;
        subcommand: string[];
    }
): void {
    const login = program
        .command("login [name]")
        .description("Log in to a subscription account (Codex grants are stored in the shared vault)")
        .option("--home <dir>", "Explicit vendor home for native credential-file login")
        .option("--auth-file <file>", "Bind an existing credential file instead of running OAuth")
        .option("--import-native", "Bind the current native CLI credential file; fail if it does not exist")
        .option("--broker", "Codex compatibility alias for the default separate vault login");

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
