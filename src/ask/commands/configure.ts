import { loadAskConfig, saveAskConfig } from "@ask/config";
import { modelSelector } from "@ask/providers/ModelSelector";
import { providerManager } from "@ask/providers/ProviderManager";
import type { AskConfig } from "@ask/types/config";
import * as p from "@clack/prompts";
import pc from "picocolors";

export async function runConfigureWizard(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" ask config ")));

    const config = await loadAskConfig();

    while (true) {
        const action = await p.select({
            message: "What would you like to configure?",
            options: [
                {
                    value: "use-claude-account",
                    label: "Use tools claude account",
                    hint: "pick from existing claude accounts",
                },
                {
                    value: "auth-subscription",
                    label: "Auth with Anthropic subscription",
                    hint: "OAuth login flow",
                },
                {
                    value: "configure-independent",
                    label: "Configure independently",
                    hint: "paste API key or token",
                },
                {
                    value: "provider-settings",
                    label: "Provider settings",
                    hint: "allow/disable env tokens",
                },
                {
                    value: "default-model",
                    label: "Default provider & model",
                    hint: config.defaultProvider
                        ? `${config.defaultProvider}/${config.defaultModel ?? "auto"}`
                        : "not set",
                },
                {
                    value: "show-config",
                    label: "Show current config",
                },
                {
                    value: "exit",
                    label: "Exit",
                },
            ],
        });

        if (p.isCancel(action) || action === "exit") {
            p.outro("Done.");
            return;
        }

        switch (action) {
            case "use-claude-account":
                await configureClaudeAccount(config);
                break;
            case "auth-subscription":
                await authWithSubscription(config);
                break;
            case "configure-independent":
                await configureIndependent(config);
                break;
            case "provider-settings":
                await configureProviderSettings(config);
                break;
            case "default-model":
                await configureDefaultModel(config);
                break;
            case "show-config":
                showCurrentConfig(config);
                break;
        }
    }
}

async function configureClaudeAccount(config: AskConfig): Promise<void> {
    const { listAvailableAccounts } = await import("@app/utils/claude/subscription-auth");
    const accounts = await listAvailableAccounts();

    if (accounts.length === 0) {
        p.log.warn("No accounts configured in tools claude.");
        p.log.info(pc.dim("Run `tools claude login` to add an account first."));
        return;
    }

    const choice = await p.select({
        message: "Which account?",
        options: accounts.map((a) => ({
            value: a.name,
            label: `${a.name}${a.label ? pc.dim(` (${a.label})`) : ""}`,
        })),
    });

    if (p.isCancel(choice)) {
        return;
    }

    const selected = accounts.find((a) => a.name === choice);

    config.claude = {
        accountRef: choice as string,
        accountLabel: selected?.label,
        accountName: choice as string,
    };

    if (!config.defaultProvider) {
        config.defaultProvider = "anthropic";
    }

    await saveAskConfig(config);

    p.log.success(`Claude account set to "${choice}".`);

    const footerPreview = `Provider: anthropic${selected?.label ? ` (${selected.label})` : ""} · ${choice}`;
    p.note(pc.dim(footerPreview), "Footer preview");
}

async function authWithSubscription(config: AskConfig): Promise<void> {
    const { claudeOAuth, fetchOAuthProfile } = await import("@app/utils/claude/auth");

    const spinner = p.spinner();
    spinner.start("Generating authorization URL...");
    const authUrl = await claudeOAuth.startLogin();
    spinner.stop("Authorization URL ready.");

    p.note(
        [
            "1. Open the URL below in your browser",
            "2. Log in with your Claude account (if needed)",
            "3. Click 'Authorize' to grant access",
            "4. Copy the code shown on the callback page",
            "   (format: code#state or just the code part)",
        ].join("\n"),
        "OAuth Login"
    );

    console.log();
    console.log(`  ${pc.cyan(authUrl)}`);
    console.log();

    const openBrowser = await p.confirm({
        message: "Open URL in browser?",
        initialValue: true,
    });

    if (p.isCancel(openBrowser)) {
        return;
    }

    if (openBrowser) {
        Bun.spawn(["open", authUrl], { stdio: ["ignore", "ignore", "ignore"] });
    }

    const code = await p.text({
        message: "Paste the authorization code:",
        placeholder: "code#state",
        validate: (val) => {
            if (!val?.trim()) {
                return "Code is required";
            }
        },
    });

    if (p.isCancel(code)) {
        return;
    }

    spinner.start("Exchanging code for tokens...");
    let tokens: Awaited<ReturnType<typeof claudeOAuth.exchangeCode>>;

    try {
        tokens = await claudeOAuth.exchangeCode(code as string);
        spinner.stop("Tokens received.");
    } catch (err) {
        spinner.stop(`Token exchange failed: ${err}`);
        return;
    }

    spinner.start("Fetching account profile...");
    const profile = await fetchOAuthProfile(tokens.accessToken);
    spinner.stop("Profile fetched.");

    const infoLines: string[] = [];

    if (tokens.account) {
        infoLines.push(`${pc.dim("Account:")} ${pc.cyan(tokens.account.email)}`);
    }

    if (profile) {
        const tier = profile.organization.rate_limit_tier;
        infoLines.push(`${pc.dim("Plan:")} ${tier}`);
    }

    infoLines.push(`${pc.dim("Expires:")} ${new Date(tokens.expiresAt).toLocaleString()}`);
    infoLines.push(`${pc.dim("Refresh:")} ${pc.green("available")}`);

    p.note(infoLines.join("\n"), "Account Authorized");

    // Determine label
    const { determineAccountLabel } = await import("@app/claude/lib/config");
    const label = determineAccountLabel(profile);

    config.claude = {
        independentToken: tokens.accessToken,
        accountLabel: label,
        accountName: tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "subscription",
    };

    if (!config.defaultProvider) {
        config.defaultProvider = "anthropic";
    }

    await saveAskConfig(config);
    p.log.success("Subscription token saved to ask config.");

    // Offer to copy to tools claude
    const copyToClaude = await p.confirm({
        message: "Copy this account to `tools claude` for usage monitoring?",
        initialValue: true,
    });

    if (!p.isCancel(copyToClaude) && copyToClaude) {
        const { loadConfig: loadClaudeConfig, saveConfig: saveClaudeConfig } = await import("@app/claude/lib/config");
        const claudeConfig = await loadClaudeConfig();
        const accountName = config.claude.accountName ?? "ask-imported";

        claudeConfig.accounts[accountName] = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            label,
        };

        if (!claudeConfig.defaultAccount) {
            claudeConfig.defaultAccount = accountName;
        }

        await saveClaudeConfig(claudeConfig);

        // Also save the account ref so it stays synced
        config.claude.accountRef = accountName;
        config.claude.independentToken = undefined;
        await saveAskConfig(config);

        p.log.success(`Account copied to tools claude as "${accountName}".`);
        p.note(
            "tools claude usage       — Monitor your Claude subscription usage\n" +
                "tools claude usage watch — Live dashboard with notifications",
            "What tools claude can do"
        );
    }
}

async function configureIndependent(config: AskConfig): Promise<void> {
    const tokenType = await p.select({
        message: "What type of token?",
        options: [
            { value: "api-key", label: "Anthropic API key", hint: "sk-ant-..." },
            { value: "oauth-token", label: "OAuth access token", hint: "from Claude subscription" },
            { value: "back", label: "Back" },
        ],
    });

    if (p.isCancel(tokenType) || tokenType === "back") {
        return;
    }

    const token = await p.text({
        message: tokenType === "api-key" ? "Paste your Anthropic API key:" : "Paste your OAuth access token:",
        validate: (val) => {
            if (!val?.trim()) {
                return "Token is required";
            }
        },
    });

    if (p.isCancel(token)) {
        return;
    }

    if (tokenType === "api-key") {
        // Set as env-style: user should add to their shell config
        p.note(
            `Add this to your shell config (~/.zshrc or ~/.bashrc):\n\n` + `  export ANTHROPIC_API_KEY="${token}"`,
            "API Key Setup"
        );
        p.log.info("The ask tool will detect it automatically via environment variable.");
    } else {
        config.claude = {
            independentToken: token as string,
            accountLabel: undefined,
            accountName: "independent",
        };

        if (!config.defaultProvider) {
            config.defaultProvider = "anthropic";
        }

        await saveAskConfig(config);
        p.log.success("OAuth token saved to ask config.");
    }
}

async function configureProviderSettings(config: AskConfig): Promise<void> {
    const envEnabled = config.envTokens?.enabled !== false;

    const masterToggle = await p.confirm({
        message: "Enable auto-detection of provider API keys from environment?",
        initialValue: envEnabled,
    });

    if (p.isCancel(masterToggle)) {
        return;
    }

    config.envTokens = {
        enabled: masterToggle as boolean,
        disabledProviders: config.envTokens?.disabledProviders,
    };

    if (masterToggle) {
        const allProviders = ["openai", "groq", "openrouter", "anthropic", "google", "xai", "jinaai"];
        const currentlyDisabled = new Set(config.envTokens.disabledProviders ?? []);

        const enabled = await p.multiselect({
            message: "Which providers should use env tokens?",
            options: allProviders.map((name) => ({
                value: name,
                label: name,
            })),
            initialValues: allProviders.filter((name) => !currentlyDisabled.has(name)),
        });

        if (p.isCancel(enabled)) {
            return;
        }

        const enabledSet = new Set(enabled as string[]);
        config.envTokens.disabledProviders = allProviders.filter((name) => !enabledSet.has(name));
    }

    await saveAskConfig(config);
    p.log.success("Provider settings saved.");
}

async function configureDefaultModel(config: AskConfig): Promise<void> {
    const spinner = p.spinner();
    spinner.start("Detecting providers...");
    const providers = await providerManager.detectProviders();
    spinner.stop(`Found ${providers.length} provider(s).`);

    if (providers.length === 0) {
        p.log.warn("No providers available. Configure API keys or a Claude subscription first.");
        return;
    }

    const modelChoice = await modelSelector.selectModel();

    if (!modelChoice) {
        return;
    }

    config.defaultProvider = modelChoice.provider.name;
    config.defaultModel = modelChoice.model.id;

    await saveAskConfig(config);
    p.log.success(`Default set to ${pc.cyan(modelChoice.provider.name)}/${pc.cyan(modelChoice.model.id)}`);
}

function showCurrentConfig(config: AskConfig): void {
    const lines: string[] = [];

    lines.push(pc.bold("Defaults:"));
    lines.push(`  Provider: ${config.defaultProvider ?? pc.dim("not set")}`);
    lines.push(`  Model:    ${config.defaultModel ?? pc.dim("not set")}`);
    lines.push(`  Temp:     ${config.temperature ?? pc.dim("default")}`);
    lines.push(`  Tokens:   ${config.maxTokens ?? pc.dim("default")}`);
    lines.push("");

    lines.push(pc.bold("Claude Subscription:"));

    if (config.claude?.accountRef) {
        lines.push(
            `  Account:  ${pc.cyan(config.claude.accountRef)}${config.claude.accountLabel ? ` (${config.claude.accountLabel})` : ""}`
        );
        lines.push(`  Source:   tools claude config`);
    } else if (config.claude?.independentToken) {
        lines.push(`  Token:    ${pc.dim(config.claude.independentToken.slice(0, 20) + "...")}`);
        lines.push(`  Name:     ${config.claude.accountName ?? pc.dim("unknown")}`);
    } else {
        lines.push(`  ${pc.dim("(not configured)")}`);
    }

    lines.push("");

    lines.push(pc.bold("Env Tokens:"));
    lines.push(`  Enabled:  ${config.envTokens?.enabled !== false ? pc.green("yes") : pc.red("no")}`);

    const disabled = config.envTokens?.disabledProviders ?? [];

    if (disabled.length > 0) {
        lines.push(`  Disabled: ${disabled.join(", ")}`);
    }

    p.note(lines.join("\n"), "Current Configuration");
}
