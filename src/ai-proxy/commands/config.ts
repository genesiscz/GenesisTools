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
import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";

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

export async function runConfigInit(): Promise<void> {
    const existing = await loadConfig();

    if (existing.accounts.length > 0) {
        out.log.warn("Config already has accounts. Use `ai-proxy config show` to inspect.");
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

    const config = getDefaultConfig();
    config.accounts = detected;
    await saveConfig(config);
    out.log.success(`Wrote config with ${detected.length} account(s)`);
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
