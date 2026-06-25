import type { ExposureVerifyResult } from "@app/ai-proxy/lib/exposure/types";
import { verifyPublicHealthProbe } from "@app/ai-proxy/lib/exposure/verify-health";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";

export async function verifyTailscaleExposure(config: AiProxyConfig): Promise<ExposureVerifyResult> {
    return verifyPublicHealthProbe(config, "tailscale mode needs public.hostname or public.tailscale.hostname");
}
