import { runConfigDetect, runConfigInit, runConfigShow } from "@app/ai-proxy/commands/config";
import { runUpCommand } from "@app/ai-proxy/commands/up";
import { detectAccounts, getDefaultConfig, loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { normalizeBasePath } from "@app/ai-proxy/lib/path-prefix";
import { buildPublicHealthUrl, resolveCursorBaseUrl } from "@app/ai-proxy/lib/public-url";
import {
    detectCloudflared,
    installCloudflared,
    isTunnelProcessRunning,
    mergeAiProxyIngress,
    parseTunnelNameFromConfig,
    probeUrl,
    readCloudflaredConfig,
    writeCloudflaredConfig,
} from "@app/ai-proxy/lib/tunnel/cloudflared";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { cancel, confirm, intro, isCancel, log, note, outro, select, spinner, text } from "@clack/prompts";

async function ensureConfigInitialized(): Promise<AiProxyConfig> {
    let config = await loadConfig();

    if (config.accounts.length === 0) {
        const detected = await detectAccounts({
            allowKeychain: true,
        });

        if (detected.length === 0) {
            throw new Error("No accounts detected. Run `grok login` or set XAI_API_KEY first.");
        }

        config = getDefaultConfig();
        config.accounts = detected;
        await saveConfig(config);
        log.success(`Initialized config with ${detected.length} account(s)`);
    }

    return config;
}

export async function runConfigMenu(): Promise<void> {
    if (!isInteractive()) {
        out.log.error("`ai-proxy config` menu requires a TTY.");
        out.log.info(suggestCommand("tools ai-proxy", { add: ["config", "setup-tunnel"] }));
        return;
    }

    intro("ai-proxy configuration");

    while (true) {
        const choice = await select({
            message: "What do you want to do?",
            options: [
                { value: "setup-tunnel", label: "Setup cloudflared tunnel (Cursor)" },
                { value: "up", label: "Start ai-proxy (up)" },
                { value: "init", label: "Initialize accounts from detection" },
                { value: "detect", label: "Detect local Grok auth / API keys" },
                { value: "show", label: "Show current config" },
                { value: "exit", label: "Exit" },
            ],
        });

        if (isCancel(choice) || choice === "exit") {
            cancel("Done.");
            return;
        }

        if (choice === "setup-tunnel") {
            await runSetupCloudflaredTunnel();
            continue;
        }

        if (choice === "up") {
            await runUpCommand();
            continue;
        }

        if (choice === "init") {
            await runConfigInit();
            continue;
        }

        if (choice === "detect") {
            await runConfigDetect();
            continue;
        }

        if (choice === "show") {
            await runConfigShow();
        }
    }
}

export async function runSetupCloudflaredTunnel(): Promise<void> {
    if (!isInteractive()) {
        out.log.error("Setup requires a TTY.");
        out.log.info(suggestCommand("tools ai-proxy", { add: ["config", "setup-tunnel"] }));
        return;
    }

    intro("ai-proxy — public exposure setup");

    let config: AiProxyConfig;
    try {
        config = await ensureConfigInitialized();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        note(message, "Prerequisite");
        outro("Fix prerequisites and re-run setup.");
        return;
    }

    const exposureMode = await select({
        message: "Public exposure provider",
        options: [
            { value: "cloudflared", label: "Cloudflare Tunnel (cloudflared)", hint: "your-domain.example style" },
            { value: "tailscale", label: "Tailscale hostname", hint: "tailnet MagicDNS — no cloudflared" },
            { value: "custom", label: "Custom public URL", hint: "you manage routing yourself" },
        ],
        initialValue: config.public?.mode === "tailscale" ? "tailscale" : "cloudflared",
    });

    if (isCancel(exposureMode)) {
        cancel("Cancelled.");
        return;
    }

    if (exposureMode === "tailscale") {
        await runSetupTailscaleExposure(config);
        return;
    }

    if (exposureMode === "custom") {
        await runSetupCustomExposure(config);
        return;
    }

    const cloudflared = await detectCloudflared();
    if (!cloudflared.installed) {
        const install = await confirm({
            message: "cloudflared not found. Install via Homebrew now?",
            initialValue: true,
        });

        if (isCancel(install) || !install) {
            cancel("Install cloudflared first: brew install cloudflared");
            return;
        }

        const s = spinner();
        s.start("Installing cloudflared");
        const ok = await installCloudflared();
        s.stop(ok ? "cloudflared installed" : "install failed");

        if (!ok) {
            outro("Install cloudflared manually, then re-run setup.");
            return;
        }
    } else {
        log.success(`cloudflared detected${cloudflared.version ? ` (${cloudflared.version})` : ""}`);
    }

    const existingYaml = await readCloudflaredConfig(config);
    const parsedTunnel = existingYaml ? parseTunnelNameFromConfig(existingYaml) : null;

    const hostname = await text({
        message: "Public hostname",
        placeholder: "proxy.example.dev",
        defaultValue: config.public?.hostname,
    });

    if (isCancel(hostname)) {
        cancel("Cancelled.");
        return;
    }

    const basePathInput = await text({
        message: "URL path prefix on that hostname",
        placeholder: "/ai",
        defaultValue: config.public?.basePath ?? "/ai",
    });

    if (isCancel(basePathInput)) {
        cancel("Cancelled.");
        return;
    }

    const tunnelName = await text({
        message: "cloudflared tunnel name",
        placeholder: "home-tunnel",
        defaultValue: config.public?.cloudflared?.tunnelName ?? parsedTunnel ?? undefined,
    });

    if (isCancel(tunnelName)) {
        cancel("Cancelled.");
        return;
    }

    const basePath = normalizeBasePath(String(basePathInput)) || "/ai";
    const publicHostname = String(hostname).trim();
    const resolvedTunnelName = String(tunnelName).trim();

    if (!publicHostname) {
        cancel("Hostname is required for cloudflared exposure.");
        return;
    }

    if (!resolvedTunnelName) {
        cancel("Tunnel name is required for cloudflared exposure.");
        return;
    }

    config.public = {
        ...config.public,
        mode: "cloudflared",
        hostname: publicHostname,
        basePath,
        cloudflared: {
            ...config.public?.cloudflared,
            tunnelName: resolvedTunnelName,
            autoStart: true,
        },
    };

    const ingressPreview = mergeAiProxyIngress(
        existingYaml ?? "tunnel: placeholder\ningress:\n  - service: http_status:404\n",
        {
            hostname: publicHostname,
            basePath,
            port: config.listen.port,
        }
    );

    note(
        [
            `Hostname:  ${publicHostname}`,
            `Base path: ${basePath}`,
            `Local:     http://127.0.0.1:${config.listen.port}`,
            `Cursor URL: https://${publicHostname}${basePath}/v1`,
            "",
            "cloudflared ingress snippet:",
            ingressPreview.yaml
                .split("\n")
                .filter(
                    (line) =>
                        line.includes("ai-proxy") ||
                        line.includes("path:") ||
                        line.includes("service: http://127.0.0.1")
                )
                .join("\n"),
        ].join("\n"),
        "Plan"
    );

    const writeIngress = await confirm({
        message: existingYaml
            ? "Update ~/.cloudflared/config.yml with the ai-proxy ingress rule?"
            : "Create ~/.cloudflared/config.yml with a minimal tunnel + ai-proxy ingress?",
        initialValue: true,
    });

    if (isCancel(writeIngress) || !writeIngress) {
        cancel("Skipped cloudflared config write. Public settings were not saved.");
        return;
    }

    const merged = mergeAiProxyIngress(
        existingYaml ??
            `tunnel: ${config.public.cloudflared?.tunnelName}\ncredentials-file: ~/.cloudflared/${config.public.cloudflared?.tunnelName}.json\ningress:\n  - service: http_status:404\n`,
        {
            hostname: publicHostname,
            basePath,
            port: config.listen.port,
        }
    );

    const configPath = await writeCloudflaredConfig(config, merged.yaml);
    await saveConfig(config);

    log.success(`Wrote cloudflared config: ${configPath}`);
    if (merged.removedLegacyRules > 0) {
        log.info(`Removed ${merged.removedLegacyRules} legacy ai-proxy ingress line(s)`);
    }

    const localHealthUrl = `http://127.0.0.1:${config.listen.port}/health`;
    const localProbe = await probeUrl(localHealthUrl);

    if (!localProbe.ok) {
        note(
            [
                "ai-proxy is not responding locally yet.",
                "",
                `Start it in another terminal:`,
                `  cd ${process.cwd().includes("ai-proxy") ? process.cwd() : "<worktree>/ai-proxy"}`,
                `  tools ai-proxy up`,
            ].join("\n"),
            "Start proxy"
        );
    } else {
        log.success(`Local health OK (${localHealthUrl})`);
    }

    const activeTunnelName = config.public.cloudflared?.tunnelName;
    const tunnelRunning = activeTunnelName ? isTunnelProcessRunning(activeTunnelName) : false;
    if (!tunnelRunning && activeTunnelName) {
        note(`tools ai-proxy up  (starts proxy + tunnel if needed)`, "Start stack");
    } else if (activeTunnelName) {
        log.success(`Tunnel process detected (${activeTunnelName})`);
    }

    const publicHealthUrl = buildPublicHealthUrl(config);
    if (publicHealthUrl && (localProbe.ok || tunnelRunning)) {
        const s = spinner();
        s.start(`Verifying ${publicHealthUrl}`);

        let publicProbe = await probeUrl(publicHealthUrl);
        if (!publicProbe.ok && !tunnelRunning) {
            s.message("Waiting for tunnel — start it if you haven't yet");
            await Bun.sleep(3000);
            publicProbe = await probeUrl(publicHealthUrl);
        }

        s.stop(publicProbe.ok ? "Public health OK" : `Public check failed (${publicProbe.status || "network"})`);

        if (!publicProbe.ok) {
            note(publicProbe.body.slice(0, 300), "Public probe");
        }
    }

    const cursorBaseUrl = resolveCursorBaseUrl(config);
    const grokAccount = config.accounts.find((account) => account.provider === "grok-subscription");
    const firstModel = grokAccount?.name ?? config.accounts[0]?.name;

    note(
        [
            "Cursor BYOK:",
            `  Base URL: https://${publicHostname}${basePath}/v1`,
            `  API Key:  ${config.proxyApiKey}`,
            firstModel
                ? `  Model:    ${firstModel}/grok/grok-composer-2.5-fast`
                : "  Model:    (add a grok-subscription account first)",
            "",
            "Keep running:",
            `  tools ai-proxy up`,
        ].join("\n"),
        "Cursor settings"
    );

    out.log.success(`Cursor Base URL: ${cursorBaseUrl}`);
    outro("Setup complete. Run: tools ai-proxy up");
}

async function runSetupTailscaleExposure(config: AiProxyConfig): Promise<void> {
    const hostname = await text({
        message: "Tailscale hostname (MagicDNS)",
        placeholder: "mac.tail12345.ts.net",
        defaultValue: config.public?.tailscale?.hostname ?? config.public?.hostname,
    });

    if (isCancel(hostname)) {
        cancel("Cancelled.");
        return;
    }

    const basePathInput = await text({
        message: "URL path prefix",
        placeholder: "/ai",
        defaultValue: config.public?.basePath ?? "/ai",
    });

    if (isCancel(basePathInput)) {
        cancel("Cancelled.");
        return;
    }

    const tailscaleHostname = String(hostname).trim();

    if (!tailscaleHostname) {
        cancel("Tailscale hostname is required.");
        return;
    }

    config.public = {
        ...config.public,
        mode: "tailscale",
        hostname: tailscaleHostname,
        basePath: normalizeBasePath(String(basePathInput)) || "/ai",
        tailscale: {
            hostname: tailscaleHostname,
            autoStart: false,
        },
    };

    await saveConfig(config);
    note(
        [
            "Tailscale mode saves hostname only — route traffic yourself (Serve/Funnel/subnet).",
            `Cursor URL: ${resolveCursorBaseUrl(config)}`,
            "Start proxy: tools ai-proxy up",
        ].join("\n"),
        "Saved"
    );
    outro("Tailscale exposure configured.");
}

async function runSetupCustomExposure(config: AiProxyConfig): Promise<void> {
    const baseUrl = await text({
        message: "Full Cursor Base URL (must end with /v1)",
        placeholder: "https://proxy.example.dev/ai/v1",
        defaultValue: config.public?.baseUrl ?? resolveCursorBaseUrl(config),
    });

    if (isCancel(baseUrl)) {
        cancel("Cancelled.");
        return;
    }

    const trimmedBaseUrl = String(baseUrl).trim();

    if (!trimmedBaseUrl.endsWith("/v1")) {
        cancel("Custom Base URL must end with /v1.");
        return;
    }

    config.public = {
        ...config.public,
        mode: "custom",
        baseUrl: trimmedBaseUrl,
    };

    await saveConfig(config);
    note(`Cursor URL: ${resolveCursorBaseUrl(config)}\nStart proxy: tools ai-proxy up`, "Saved");
    outro("Custom exposure configured.");
}
