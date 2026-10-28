import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { Command } from "commander";
import { bindsCredentialFiles, type DoorFlag, doorFlags } from "../../lib/accounts/login-flags";
import {
    declaresLoginVariant,
    LOGIN_VARIANT_KEYS,
    LOGIN_VARIANT_VERBS,
    type LoginVariantKey,
} from "../../lib/accounts/login-variants";
import { runLogin } from "../../lib/accounts/run-login";

const PROVIDER_HELP = `Provider: ${ACCOUNT_PROVIDER_ALIASES.join(", ")} (plugin ids also accepted)`;

interface LoginFlags {
    provider?: string | true;
    home?: string;
    authFile?: string;
    importNative?: boolean;
}

/**
 * Declare a door's provider switches on `command`, and return the reader that names the ones a
 * run set. The command knows no switch by name: each comes from the plugin that declared it.
 */
function declareProviderFlags(
    command: Command,
    flags: readonly DoorFlag[]
): (parsed: Record<string, unknown>) => ReadonlySet<string> {
    const declared = flags.map(({ flag, hidden }) => {
        const option = command.createOption(`--${flag.name}`, flag.description).hideHelp(hidden);
        command.addOption(option);

        return { name: flag.name, key: option.attributeName() };
    });

    return (parsed) => new Set(declared.filter(({ key }) => parsed[key] === true).map(({ name }) => name));
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
    registerBuiltInPlugins();

    const login = program
        .command("login [name]")
        .description(opts.description ?? "Log in to a subscription account, storing the grant in the shared vault");

    // The core's own flags, offered where the run can honour them; `runLogin` asks the same question.
    if (opts.provider === undefined || bindsCredentialFiles(providerPlugin(opts.provider))) {
        login
            .option("--home <dir>", "Explicit vendor home for native credential-file login")
            .option("--auth-file <file>", "Bind an existing credential file instead of running OAuth")
            .option("--import-native", "Bind the current native CLI credential file; fail if it does not exist");
    }

    const providerFlags = declareProviderFlags(
        login,
        doorFlags(opts.provider, (features) => features.loginFlags)
    );

    if (!opts.provider) {
        login.option("--provider [value]", PROVIDER_HELP);
    }

    login.action(async (name: string | undefined, flags: LoginFlags & Record<string, unknown>) => {
        await runLogin({
            provider: opts.provider ?? flags.provider,
            name,
            home: flags.home,
            authFile: flags.authFile,
            importNative: flags.importNative,
            providerFlags: providerFlags(flags),
            tool: opts.tool,
            subcommand: opts.subcommand,
        });
    });
}

/**
 * One login verb beside `login` (`login-long`, `login-secondary`), registered only when the door's
 * provider declares that variant; the provider-neutral door registers it when any provider does.
 */
export function registerLoginVariantCommand(
    program: Command,
    opts: {
        variant: LoginVariantKey;
        provider?: string;
        tool: string;
        subcommand: string[];
        /** One line for `--help`; the provider-neutral door keeps the generic wording. */
        description?: string;
    }
): void {
    registerBuiltInPlugins();

    if (!declaresLoginVariant(opts.provider, opts.variant)) {
        return;
    }

    const verb = LOGIN_VARIANT_VERBS[opts.variant];
    const command = program.command(`${verb.verb} [name]`).description(opts.description ?? verb.description);

    if (!opts.provider) {
        command.option("--provider [value]", PROVIDER_HELP);
    }

    const providerFlags = declareProviderFlags(
        command,
        doorFlags(opts.provider, (features) => features.loginVariants[opts.variant]?.flags ?? [])
    );

    command.action(async (name: string | undefined, flags: { provider?: string | true } & Record<string, unknown>) => {
        await verb.run({
            provider: opts.provider ?? flags.provider,
            name,
            providerFlags: providerFlags(flags),
            tool: opts.tool,
            subcommand: opts.subcommand,
        });
    });
}

/** Every login verb beside `login` that the door's provider declares, each as `<tool> <verb>`. */
export function registerLoginVariantCommands(
    program: Command,
    opts: { provider?: string; tool: string; subcommand: string[] }
): void {
    for (const variant of LOGIN_VARIANT_KEYS) {
        const { verb } = LOGIN_VARIANT_VERBS[variant];

        registerLoginVariantCommand(program, {
            variant,
            provider: opts.provider,
            tool: `${opts.tool} ${verb}`,
            subcommand: [...opts.subcommand, verb],
        });
    }
}

export function registerAiProviderLoginCommands(program: Command): void {
    const codex = program.command("codex").description("Codex subscription account commands");
    registerAccountLoginCommand(codex, {
        provider: "openai-sub",
        tool: `${toolCommand("ai codex login")}`,
        subcommand: ["codex", "login"],
    });
}
