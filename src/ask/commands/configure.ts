import { AIConfig } from "@app/utils/ai/AIConfig";
import type { AIAccountEntry, AIProvider } from "@app/utils/config/ai.types";
import { loadAskConfig, saveAskConfig } from "@ask/config";
import { modelSelector } from "@ask/providers/ModelSelector";
import { providerManager } from "@ask/providers/ProviderManager";
import type { AskConfig } from "@ask/types/config";
import * as p from "@clack/prompts";
import pc from "picocolors";

export async function runConfigureWizard(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" ask config ")));

    const config = await loadAskConfig();
    const aiConfig = await AIConfig.load();
    const accounts = aiConfig.listAccounts();

    while (true) {
        const action = await p.select({
            message: "What would you like to configure?",
            options: [
                {
                    value: "manage-accounts",
                    label: "Manage accounts",
                    hint: `${accounts.length} account(s)`,
                },
                {
                    value: "default-model",
                    label: "Default provider & model",
                    hint: (() => {
                        const defaults = aiConfig.getAppDefaults("ask");
                        return defaults?.provider ? `${defaults.provider}/${defaults.model ?? "auto"}` : "not set";
                    })(),
                },
                {
                    value: "provider-settings",
                    label: "Provider settings",
                    hint: "env tokens",
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
            case "manage-accounts":
                await manageAccounts();
                break;
            case "provider-settings":
                await configureProviderSettings(config);
                break;
            case "default-model":
                await configureDefaultModel(config);
                break;
            case "show-config":
                await showCurrentConfig(config);
                break;
        }
    }
}

// ── Account Management ──

async function manageAccounts(): Promise<void> {
    const aiConfig = await AIConfig.load();

    while (true) {
        const accounts = aiConfig.listAccounts();

        const options: Array<{ value: string; label: string; hint?: string }> = accounts.map((a) => ({
            value: `view:${a.name}`,
            label: `${a.name} (${a.provider})${a.label ? pc.dim(` · ${a.label}`) : ""}`,
            hint: a.apps?.join(", "),
        }));

        options.push({ value: "add", label: pc.green("+ Add new account") }, { value: "back", label: "Back" });

        const choice = await p.select({
            message: "Accounts",
            options,
        });

        if (p.isCancel(choice) || choice === "back") {
            return;
        }

        if (choice === "add") {
            await addAccount();
            continue;
        }

        if (typeof choice === "string" && choice.startsWith("view:")) {
            const name = choice.slice(5);
            await viewAccount(name);
        }
    }
}

async function viewAccount(name: string): Promise<void> {
    const aiConfig = await AIConfig.load();
    const account = aiConfig.getAccount(name);

    if (!account) {
        p.log.error(`Account "${name}" not found.`);
        return;
    }

    const lines = [
        `${pc.dim("Name:")}     ${account.name}`,
        `${pc.dim("Provider:")} ${account.provider}`,
        `${pc.dim("Label:")}    ${account.label ?? pc.dim("none")}`,
        `${pc.dim("Apps:")}     ${account.apps?.join(", ") ?? pc.dim("none")}`,
        `${pc.dim("API Key:")}  ${account.tokens.apiKey ? pc.dim("configured") : pc.dim("none")}`,
        `${pc.dim("OAuth:")}    ${account.tokens.accessToken ? pc.dim("configured") : pc.dim("none")}`,
    ];

    if (account.tokens.expiresAt) {
        lines.push(`${pc.dim("Expires:")}  ${new Date(account.tokens.expiresAt).toLocaleString()}`);
    }

    p.note(lines.join("\n"), account.name);

    const action = await p.select({
        message: "Action",
        options: [
            { value: "remove", label: pc.red("Remove account") },
            { value: "back", label: "Back" },
        ],
    });

    if (p.isCancel(action) || action === "back") {
        return;
    }

    if (action === "remove") {
        const confirm = await p.confirm({
            message: `Remove account "${name}"?`,
            initialValue: false,
        });

        if (!p.isCancel(confirm) && confirm) {
            await aiConfig.removeAccount(name);
            p.log.success(`Account "${name}" removed.`);
        }
    }
}

async function addAccount(): Promise<void> {
    const provider = await p.select({
        message: "Provider",
        options: [
            { value: "anthropic", label: "Anthropic" },
            { value: "openai", label: "OpenAI / Codex" },
            { value: "back", label: "Back" },
        ],
    });

    if (p.isCancel(provider) || provider === "back") {
        return;
    }

    if (provider === "anthropic") {
        await addAnthropicAccount();
    } else if (provider === "openai") {
        await addOpenAIAccount();
    }
}

// ── Anthropic Account Flows ──

async function addAnthropicAccount(): Promise<void> {
    const method = await p.select({
        message: "Anthropic account type",
        options: [
            {
                value: "from-claude",
                label: "Add from tools claude account",
                hint: "pick from existing claude accounts",
            },
            {
                value: "auth-subscription",
                label: "Auth with Anthropic Max Plan",
                hint: "OAuth browser flow",
            },
            {
                value: "oauth-key",
                label: "Add OAuth key",
                hint: 'from "claude setup-token"',
            },
            {
                value: "api-key",
                label: "Add API key",
                hint: "standard sk-ant-api...",
            },
            { value: "back", label: "Back" },
        ],
    });

    if (p.isCancel(method) || method === "back") {
        return;
    }

    switch (method) {
        case "from-claude":
            await addFromClaudeAccount();
            break;
        case "auth-subscription":
            await addViaOAuthFlow();
            break;
        case "oauth-key":
            await addOAuthKey();
            break;
        case "api-key":
            await addAnthropicApiKey();
            break;
    }
}

async function addFromClaudeAccount(): Promise<void> {
    const { listAvailableAccounts } = await import("@app/utils/claude/subscription-auth");
    const accounts = await listAvailableAccounts();

    if (accounts.length === 0) {
        p.log.warn("No accounts configured in tools claude.");
        p.log.info(pc.dim("Run `tools claude login` to add an account first."));
        return;
    }

    const choice = await p.select({
        message: "Which claude account?",
        options: accounts.map((a) => ({
            value: a.name,
            label: `${a.name}${a.label ? pc.dim(` (${a.label})`) : ""}`,
        })),
    });

    if (p.isCancel(choice)) {
        return;
    }

    const selected = accounts.find((a) => a.name === choice);

    if (!selected) {
        p.log.error(`Account "${choice}" not found.`);
        return;
    }

    // Tokens are managed by AIConfig's refresh pipeline.
    const entry: AIAccountEntry = {
        name: choice as string,
        provider: "anthropic-sub",
        tokens: {
            accessToken: selected.accessToken || undefined,
            refreshToken: selected.refreshToken,
            expiresAt: selected.expiresAt,
        },
        label: selected.label,
        apps: ["ask", "claude"],
    };

    const aiConfig = await AIConfig.load();
    await aiConfig.addAccount(entry);

    // Also set as ask config's claude account for backward compat
    const askConfig = await loadAskConfig();

    askConfig.claude = {
        accountRef: entry.name,
        accountLabel: entry.label,
        accountName: entry.name,
    };

    if (!askConfig.defaultProvider) {
        askConfig.defaultProvider = "anthropic";
    }

    await saveAskConfig(askConfig);
    p.log.success(`Account "${entry.name}" added from tools claude.`);
}

async function addViaOAuthFlow(): Promise<void> {
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
        const { Browser } = await import("@app/utils/browser");
        await Browser.open(authUrl);
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
    let profile: Awaited<ReturnType<typeof fetchOAuthProfile>> | null = null;

    try {
        profile = await fetchOAuthProfile(tokens.accessToken);
        spinner.stop("Profile fetched.");
    } catch (err) {
        spinner.stop(pc.yellow(`Profile fetch failed: ${err instanceof Error ? err.message : err}`));
        p.log.warn("Continuing without profile info — token is still valid.");
    }

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

    // Determine label and name
    const { determineAccountLabel } = await import("@app/claude/lib/config");
    const label = determineAccountLabel(profile ?? undefined);
    const accountName = tokens.account?.email?.split("@")[0]?.toLowerCase() ?? "subscription";

    const entry: AIAccountEntry = {
        name: accountName,
        provider: "anthropic-sub",
        tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
        },
        label,
        apps: ["ask", "claude"],
    };

    const aiConfig = await AIConfig.load();
    await aiConfig.addAccountWithDefaults(entry);

    // Also update ask config for backward compat
    const askConfig = await loadAskConfig();

    askConfig.claude = {
        accountRef: entry.name,
        accountLabel: label,
        accountName: entry.name,
    };

    if (!askConfig.defaultProvider) {
        askConfig.defaultProvider = "anthropic";
    }

    await saveAskConfig(askConfig);
    p.log.success(`Account "${entry.name}" added via OAuth.`);
}

async function addOAuthKey(): Promise<void> {
    const token = await p.text({
        message: "Paste your OAuth access token:",
        placeholder: "sk-ant-oat01-...",
        validate: (val) => {
            if (!val?.trim()) {
                return "Token is required";
            }
        },
    });

    if (p.isCancel(token)) {
        return;
    }

    const name = await p.text({
        message: "Account name:",
        placeholder: "my-claude-sub",
        validate: (val) => {
            if (!val?.trim()) {
                return "Name is required";
            }
        },
    });

    if (p.isCancel(name)) {
        return;
    }

    const entry: AIAccountEntry = {
        name: name as string,
        provider: "anthropic-sub",
        tokens: {
            accessToken: token as string,
        },
        apps: ["ask"],
    };

    const aiConfig = await AIConfig.load();
    await aiConfig.addAccount(entry);
    p.log.success(`Account "${name}" added with OAuth token.`);
}

async function addAnthropicApiKey(): Promise<void> {
    const key = await p.text({
        message: "Paste your Anthropic API key:",
        placeholder: "sk-ant-api03-...",
        validate: (val) => {
            if (!val?.trim()) {
                return "API key is required";
            }
        },
    });

    if (p.isCancel(key)) {
        return;
    }

    const name = await p.text({
        message: "Account name:",
        placeholder: "anthropic-api",
        validate: (val) => {
            if (!val?.trim()) {
                return "Name is required";
            }
        },
    });

    if (p.isCancel(name)) {
        return;
    }

    const entry: AIAccountEntry = {
        name: name as string,
        provider: "anthropic",
        tokens: {
            apiKey: key as string,
        },
        apps: ["ask"],
    };

    const aiConfig = await AIConfig.load();
    await aiConfig.addAccount(entry);
    p.log.success(`Account "${name}" added with API key.`);
}

// ── OpenAI Account Flow ──

async function addOpenAIAccount(): Promise<void> {
    const key = await p.text({
        message: "Paste your OpenAI API key:",
        placeholder: "sk-...",
        validate: (val) => {
            if (!val?.trim()) {
                return "API key is required";
            }
        },
    });

    if (p.isCancel(key)) {
        return;
    }

    const name = await p.text({
        message: "Account name:",
        placeholder: "openai-api",
        validate: (val) => {
            if (!val?.trim()) {
                return "Name is required";
            }
        },
    });

    if (p.isCancel(name)) {
        return;
    }

    const entry: AIAccountEntry = {
        name: name as string,
        provider: "openai",
        tokens: {
            apiKey: key as string,
        },
        apps: ["ask"],
    };

    const aiConfig = await AIConfig.load();
    await aiConfig.addAccount(entry);
    p.log.success(`Account "${name}" added with OpenAI API key.`);
}

// ── Provider Settings ──

async function configureProviderSettings(_config: AskConfig): Promise<void> {
    const aiConfig = await AIConfig.load();
    const allProviders = ["openai", "groq", "openrouter", "anthropic", "google", "xai", "jinaai"];

    // Determine current state from AIConfig
    const allDisabled = allProviders.every((name) => !aiConfig.isProviderEnabled(name));

    const masterToggle = await p.confirm({
        message: "Enable auto-detection of provider API keys from environment?",
        initialValue: !allDisabled,
    });

    if (p.isCancel(masterToggle)) {
        return;
    }

    if (masterToggle) {
        const enabled = await p.multiselect({
            message: "Which providers should use env tokens?",
            options: allProviders.map((name) => ({
                value: name,
                label: name,
            })),
            initialValues: allProviders.filter((name) => aiConfig.isProviderEnabled(name)),
        });

        if (p.isCancel(enabled)) {
            return;
        }

        const enabledSet = new Set(enabled as string[]);

        await aiConfig.mutate((data) => {
            for (const name of allProviders) {
                const isEnabled = enabledSet.has(name);

                if (data.providers[name]) {
                    data.providers[name].enabled = isEnabled;
                } else {
                    data.providers[name] = { enabled: isEnabled, envVariable: "" };
                }
            }
        });
    } else {
        await aiConfig.mutate((data) => {
            for (const name of allProviders) {
                if (data.providers[name]) {
                    data.providers[name].enabled = false;
                } else {
                    data.providers[name] = { enabled: false, envVariable: "" };
                }
            }
        });
    }

    p.log.success("Provider settings saved.");
}

// ── Default Model ──

async function configureDefaultModel(_config: AskConfig): Promise<void> {
    const aiConfig = await AIConfig.load();
    const askDefaults = aiConfig.getAppDefaults("ask");
    const currentInfo = askDefaults?.provider ? `${askDefaults.provider}/${askDefaults.model ?? "auto"}` : "not set";

    const action = await p.select({
        message: `Default: ${currentInfo}. What do you want to do?`,
        options: [
            { value: "set", label: "Set default provider & model" },
            { value: "unset-both", label: "Unset both", hint: "remove default provider and model" },
            { value: "unset-model", label: "Unset model only", hint: "keep provider, clear model" },
            { value: "unset-provider", label: "Unset provider only", hint: "keep model, clear provider" },
        ],
    });

    if (p.isCancel(action)) {
        return;
    }

    if (action === "unset-both") {
        await aiConfig.setAppDefaults("ask", { provider: undefined, model: undefined });
        p.log.success("Default provider and model unset.");
        return;
    }

    if (action === "unset-model") {
        await aiConfig.setAppDefaults("ask", { model: undefined });
        p.log.success("Default model unset.");
        return;
    }

    if (action === "unset-provider") {
        await aiConfig.setAppDefaults("ask", { provider: undefined });
        p.log.success("Default provider unset.");
        return;
    }

    const spinner = p.spinner();
    spinner.start("Detecting providers...");
    const providers = await providerManager.detectProviders();
    spinner.stop(`Found ${providers.length} provider(s).`);

    if (providers.length === 0) {
        p.log.warn("No providers available. Configure API keys or a subscription first.");
        return;
    }

    const modelChoice = await modelSelector.selectModel();

    if (!modelChoice) {
        return;
    }

    await aiConfig.setAppDefaults("ask", {
        provider: modelChoice.provider.name,
        model: modelChoice.model.id,
    });

    p.log.success(`Default set to ${pc.cyan(modelChoice.provider.name)}/${pc.cyan(modelChoice.model.id)}`);
}

// ── Show Config ──

async function showCurrentConfig(_config: AskConfig): Promise<void> {
    const aiConfig = await AIConfig.load();
    const accounts = aiConfig.listAccounts();
    const defaultAccount = aiConfig.getDefaultAccount("ask");
    const askDefaults = aiConfig.getAppDefaults("ask");
    const lines: string[] = [];

    lines.push(pc.bold("Defaults:"));
    lines.push(`  Provider: ${askDefaults?.provider ?? pc.dim("not set")}`);
    lines.push(`  Model:    ${askDefaults?.model ?? pc.dim("not set")}`);
    lines.push(`  Temp:     ${askDefaults?.temperature ?? pc.dim("default")}`);
    lines.push(`  Tokens:   ${askDefaults?.maxTokens ?? pc.dim("default")}`);
    lines.push("");

    lines.push(pc.bold(`Accounts (${accounts.length}):`));

    if (accounts.length === 0) {
        lines.push(`  ${pc.dim("(none)")}`);
    } else {
        for (const a of accounts) {
            const isDefault = a.name === defaultAccount?.name;
            const marker = isDefault ? pc.green("★") : " ";
            const providerLabel = formatProvider(a.provider);
            const label = a.label ? pc.dim(` · ${a.label}`) : "";
            const apps = a.apps?.length ? pc.dim(` [${a.apps.join(", ")}]`) : "";
            lines.push(`  ${marker} ${a.name} (${providerLabel})${label}${apps}`);
        }
    }

    lines.push("");
    lines.push(pc.bold("Env Tokens:"));

    const knownProviders = ["openai", "groq", "openrouter", "anthropic", "google", "xai", "jinaai"];
    const disabledProviders = knownProviders.filter((name) => !aiConfig.isProviderEnabled(name));
    const allEnabled = disabledProviders.length === 0;
    lines.push(`  Enabled:  ${allEnabled ? pc.green("yes") : pc.red("partial")}`);

    if (disabledProviders.length > 0) {
        lines.push(`  Disabled: ${disabledProviders.join(", ")}`);
    }

    p.note(lines.join("\n"), "Current Configuration");
}

function formatProvider(provider: AIProvider): string {
    const labels: Record<string, string> = {
        "anthropic-sub": "anthropic subscription",
        "openai-sub": "openai subscription",
    };
    return labels[provider] ?? provider;
}
