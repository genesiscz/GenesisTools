import { join } from "node:path";
import { getDashboardAuthCached } from "@app/dev-dashboard/config";
import {
    cloudflaredHome,
    createTunnel,
    detectCloudflared,
    installCloudflared,
    loginCloudflared,
    requestManagedSubdomain,
    routeDns,
    writeConfig,
} from "@app/dev-dashboard/lib/tunnel/cloudflared";
import { buildPairingPayload, persistPairing } from "@app/dev-dashboard/lib/tunnel/pairing";
import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { renderQr } from "@app/utils/qr";
import { cancel, confirm, intro, isCancel, log, note, outro, select, spinner, text } from "@clack/prompts";

const TUNNEL_NAME = "devdashboard";

export interface TunnelSetupOptions {
    port: number;
}

export async function runTunnelSetup(opts: TunnelSetupOptions): Promise<void> {
    if (!isInteractive()) {
        out.error("`tunnel setup` is an interactive wizard and needs a TTY.");
        out.error(suggestCommand("tools dev-dashboard tunnel setup", { add: ["--port", String(opts.port)] }));
        process.exitCode = 1;
        return;
    }

    intro("DevDashboard — remote access tunnel setup (self-hosted Cloudflare Tunnel)");

    const detected = await detectCloudflared();

    if (!detected.installed) {
        const s = spinner();
        s.start("cloudflared not found — installing via Homebrew");
        const ok = await installCloudflared();
        s.stop(ok ? "cloudflared installed" : "install failed");

        if (!ok) {
            note(
                "Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation",
                "Manual step"
            );
            outro("Re-run `tools dev-dashboard tunnel setup` after installing.");
            return;
        }
    } else {
        log.success(`cloudflared detected (${detected.version ?? "unknown version"})`);
    }

    const domainChoice = await select({
        message: "How do you want to reach your Mac?",
        options: [
            {
                value: "own",
                label: "Use my own domain",
                hint: "you own a domain on Cloudflare — vendor is NEVER in your data path",
            },
            {
                value: "managed",
                label: "Get a managed subdomain (<name>.devdashboard.app)",
                hint: "no domain needed — see the trust note",
            },
        ],
    });

    if (isCancel(domainChoice)) {
        cancel("Cancelled.");
        return;
    }

    if (domainChoice === "managed") {
        await runManagedBranch(opts);
        return;
    }

    await runOwnDomainBranch(opts);
}

async function runOwnDomainBranch(opts: TunnelSetupOptions): Promise<void> {
    log.step("A browser will open for Cloudflare login. Pick the domain you want to use.");
    const loginResult = await loginCloudflared();

    if (loginResult.code !== 0) {
        note(loginResult.stderr || "login failed", "Cloudflare login");
        outro("Login did not complete — try again.");
        return;
    }

    const hostname = await text({
        message: "Public hostname for the dashboard",
        placeholder: "mac.yourdomain.com",
    });

    if (isCancel(hostname)) {
        cancel("Cancelled.");
        return;
    }

    const created = await createTunnel(TUNNEL_NAME);

    if (!created.tunnelId) {
        note(created.raw.stderr || created.raw.stdout, "tunnel create");
        outro("Could not create the tunnel.");
        return;
    }

    const route = await routeDns(TUNNEL_NAME, String(hostname));

    if (route.code !== 0) {
        note(route.stderr, "route dns");
        outro("DNS routing failed.");
        return;
    }

    await emitPairing({
        opts,
        hostname: String(hostname),
        tunnelId: created.tunnelId,
        baseUrl: `https://${hostname}`,
        // Own-domain on the user's own CF: the vendor is never in the data path → tier-3 trust.
        vendorFronted: false,
        trustLine: "The vendor is NEVER in your data path — your Mac and Cloudflare account hold everything.",
    });
}

async function runManagedBranch(opts: TunnelSetupOptions): Promise<void> {
    note(
        [
            "A managed subdomain (<name>.devdashboard.app) lets you connect WITHOUT owning a domain.",
            "",
            "TRUST CAVEAT: when the vendor's Cloudflare account fronts the subdomain, the vendor edge",
            "terminates TLS — so it could see plaintext traffic UNLESS the end-to-end (E2E) layer is on.",
            "This variant therefore REQUIRES the managed-tier E2E encryption for the 'we can't see your",
            "data' guarantee. If you want unconditional no-see trust, choose 'Use my own domain' (or",
            "Tailscale) instead.",
        ].join("\n"),
        "Managed subdomain — read this"
    );

    const proceed = await confirm({ message: "Continue with a managed subdomain (E2E-protected)?" });

    if (isCancel(proceed) || !proceed) {
        cancel("Cancelled — no managed subdomain reserved.");
        return;
    }

    const desiredName = await text({
        message: "Desired subdomain name",
        placeholder: "martin",
    });

    if (isCancel(desiredName)) {
        cancel("Cancelled.");
        return;
    }

    const cloudApiToken = await text({
        message: "DevDashboard Cloud API token",
        placeholder: "ddc_…",
    });

    if (isCancel(cloudApiToken)) {
        cancel("Cancelled.");
        return;
    }

    try {
        const reserved = await requestManagedSubdomain({
            cloudApiToken: String(cloudApiToken),
            desiredName: String(desiredName),
        });

        await emitPairing({
            opts,
            hostname: reserved.hostname,
            tunnelId: TUNNEL_NAME,
            baseUrl: `https://${reserved.hostname}`,
            vendorFronted: reserved.vendorFronted,
            trustLine: reserved.vendorFronted
                ? "The vendor edge terminates TLS — your data stays private ONLY via the E2E layer (keys live on your Mac + phone)."
                : "DNS is delegated to your own Cloudflare — tier-3 trust preserved (vendor not in the data path).",
        });
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: managed subdomain request failed");
        note(
            "Managed subdomains require the DevDashboard Cloud API, which is not available yet (plan 10). Use your own domain or Tailscale for now.",
            "Not available yet"
        );
        outro("Managed subdomain setup could not complete.");
    }
}

interface EmitPairingInput {
    opts: TunnelSetupOptions;
    hostname: string;
    tunnelId: string;
    baseUrl: string;
    vendorFronted: boolean;
    trustLine: string;
}

async function emitPairing(input: EmitPairingInput): Promise<void> {
    const provision = await getDashboardAuthCached();
    const pairingUri = buildPairingPayload({
        tier: input.vendorFronted ? "managed" : "cloudflared-self",
        baseUrl: input.baseUrl,
        username: provision.auth.username,
    });

    if (!input.vendorFronted) {
        await writeConfig({
            tunnelId: input.tunnelId,
            // Absolute path — cloudflared's YAML parser does not expand `~`.
            credentialsFile: join(cloudflaredHome(), `${input.tunnelId}.json`),
            hostname: input.hostname,
            localPort: input.opts.port,
        });
    }

    await persistPairing(
        {
            tunnelName: TUNNEL_NAME,
            tunnelId: input.tunnelId,
            hostname: input.hostname,
            localPort: input.opts.port,
        },
        pairingUri
    );

    note(`${input.hostname} -> 127.0.0.1:${input.opts.port}`, "Tunnel ready");
    out.println(`\nTrust: ${input.trustLine}\n`);
    out.println("Scan this QR in the DevDashboard mobile app to pair:\n");
    out.println(renderQr(pairingUri, { small: true }));
    out.println(`\nOr paste this pairing URI:\n  ${pairingUri}\n`);
    note("Run the tunnel: `cloudflared tunnel run devdashboard` (or add it as a launchd/login service).", "Next");
    outro("Tunnel ready.");
}
