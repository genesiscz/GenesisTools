import { ensureCloudflaredExposure, verifyCloudflaredExposure } from "@app/ai-proxy/lib/exposure/cloudflared";
import { verifyTailscaleExposure } from "@app/ai-proxy/lib/exposure/tailscale";
import type { ExposureEnsureResult, ExposureVerifyResult } from "@app/ai-proxy/lib/exposure/types";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";

export async function ensurePublicExposure(config: AiProxyConfig): Promise<ExposureEnsureResult> {
    const mode = config.public?.mode ?? "none";

    if (mode === "none") {
        return { started: false, message: "Public exposure disabled (local only)" };
    }

    if (mode === "cloudflared") {
        return ensureCloudflaredExposure(config);
    }

    if (mode === "tailscale") {
        return {
            started: false,
            message: "Tailscale exposure configured — use your tailnet hostname directly (no tunnel process managed)",
        };
    }

    if (mode === "custom") {
        return {
            started: false,
            message: "Custom public URL configured — no tunnel process managed",
        };
    }

    return { started: false, message: `Unknown exposure mode: ${mode}` };
}

export async function verifyPublicExposure(config: AiProxyConfig): Promise<ExposureVerifyResult | null> {
    const mode = config.public?.mode ?? "none";

    if (mode === "none") {
        return null;
    }

    if (mode === "cloudflared") {
        return verifyCloudflaredExposure(config);
    }

    if (mode === "tailscale") {
        return verifyTailscaleExposure(config);
    }

    if (mode === "custom") {
        const { verifyPublicHealthProbe } = await import("@app/ai-proxy/lib/exposure/verify-health");
        return verifyPublicHealthProbe(config, "custom mode missing baseUrl/hostname");
    }

    return null;
}
