import {
    detectAccountReports,
    detectAccounts,
    getDefaultConfig,
    loadConfig,
    redactConfig,
    saveConfig,
} from "@app/ai-proxy/lib/config";
import { formatDetectReportText } from "@app/ai-proxy/lib/detect-report";
import { isValidThinkingMode } from "@app/ai-proxy/lib/thinking-config";
import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";

export async function runConfigDetect(): Promise<void> {
    const reports = await detectAccountReports({
        allowKeychain: true,
    });

    if (reports.length === 0) {
        out.printlnErr(
            "No accounts detected. Ensure ~/.grok/auth.json exists, run `ai-proxy accounts login github-copilot`, or set XAI_API_KEY."
        );
        return;
    }

    out.println(formatDetectReportText(reports));
}

export async function runConfigInit(options?: { append?: boolean }): Promise<void> {
    const existing = await loadConfig();

    if (existing.accounts.length > 0 && !options?.append) {
        out.log.warn("Config already has accounts. Use `ai-proxy config show` to inspect.");
        out.log.info(suggestCommand("tools ai-proxy", { add: ["config", "init", "--append"] }));
        return;
    }

    const detected = await detectAccounts({
        allowKeychain: isInteractive(),
    });

    if (detected.length === 0) {
        out.log.error("No accounts detected.");

        if (!isInteractive()) {
            out.log.info(suggestCommand("tools ai-proxy", { add: ["config", "init"] }));
        }

        return;
    }

    if (existing.accounts.length === 0) {
        const config = getDefaultConfig();
        config.accounts = detected;
        await saveConfig(config);
        out.log.success(`Wrote config with ${detected.length} account(s)`);
        return;
    }

    // Matched on provider TYPE, not on name: the point is "this proxy cannot yet
    // reach OpenRouter at all", and an existing account of that type already
    // answers that — re-adding it under a detected name would give the user two
    // accounts billing one key. Existing entries are never touched.
    const configuredTypes = new Set(existing.accounts.map((account) => account.provider));
    const additions = detected.filter((account) => !configuredTypes.has(account.provider));

    if (additions.length === 0) {
        out.log.info("Every detected provider already has an account. Nothing to append.");
        return;
    }

    // Names are the routing key, so a collision with an existing account would
    // silently shadow it.
    const usedNames = new Set(existing.accounts.map((account) => account.name));

    for (const account of additions) {
        while (usedNames.has(account.name)) {
            account.name = `${account.name}-2`;
        }

        usedNames.add(account.name);
    }

    existing.accounts = [...existing.accounts, ...additions];
    await saveConfig(existing);
    out.log.success(
        `Appended ${additions.length} account(s): ${additions.map((account) => `${account.name} (${account.provider})`).join(", ")}`
    );
}

export async function runConfigShow(): Promise<void> {
    const config = await loadConfig();
    out.result(redactConfig(config));
}

export async function runConfigSet(options: {
    port?: number;
    proxyKey?: string;
    translate?: "auto" | "on" | "off";
    thinking?: string;
    publicHostname?: string;
    publicBasePath?: string;
    exposureMode?: "none" | "cloudflared" | "tailscale" | "custom";
    publicBaseUrl?: string;
    tunnelName?: string;
    cloudflaredConfigPath?: string;
    cloudflaredAutoStart?: boolean;
}): Promise<void> {
    const config = await loadConfig();

    if (options.port !== undefined) {
        config.listen.port = options.port;
    }

    if (options.proxyKey) {
        config.proxyApiKey = options.proxyKey;
    }

    if (options.translate) {
        config.translation.cursorAgent = options.translate;
    }

    if (options.thinking) {
        if (!isValidThinkingMode(options.thinking)) {
            out.log.error(`Invalid thinking mode: ${options.thinking} (use raw, cursor, or folded)`);
            return;
        }

        config.translation.thinking = options.thinking as ThinkingPresentationMode;
    }

    if (
        options.publicHostname ||
        options.publicBasePath ||
        options.exposureMode ||
        options.publicBaseUrl ||
        options.tunnelName ||
        options.cloudflaredConfigPath ||
        options.cloudflaredAutoStart !== undefined
    ) {
        config.public = { ...config.public, cloudflared: { ...config.public?.cloudflared } };

        if (options.exposureMode) {
            config.public.mode = options.exposureMode;
        }

        if (options.publicHostname) {
            config.public.hostname = options.publicHostname;
        }

        if (options.publicBasePath) {
            config.public.basePath = options.publicBasePath;
        }

        if (options.publicBaseUrl) {
            config.public.baseUrl = options.publicBaseUrl;
        }

        if (options.tunnelName) {
            config.public.cloudflared = { ...config.public.cloudflared, tunnelName: options.tunnelName };
        }

        if (options.cloudflaredConfigPath) {
            config.public.cloudflared = { ...config.public.cloudflared, configPath: options.cloudflaredConfigPath };
        }

        if (options.cloudflaredAutoStart !== undefined) {
            config.public.cloudflared = { ...config.public.cloudflared, autoStart: options.cloudflaredAutoStart };
        }
    }

    await saveConfig(config);
    out.log.success("Config updated");
}
