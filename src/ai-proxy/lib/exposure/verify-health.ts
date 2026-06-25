import type { ExposureVerifyResult } from "@app/ai-proxy/lib/exposure/types";
import { buildPublicHealthUrl } from "@app/ai-proxy/lib/public-url";
import { probeUrl } from "@app/ai-proxy/lib/tunnel/cloudflared";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";

export async function verifyPublicHealthProbe(
    config: AiProxyConfig,
    missingDetail: string
): Promise<ExposureVerifyResult> {
    const url = buildPublicHealthUrl(config) ?? "";

    if (!url) {
        return { ok: false, url: "", detail: missingDetail };
    }

    const probe = await probeUrl(url);
    return {
        ok: probe.ok,
        url,
        detail: probe.ok ? "ok" : probe.body.slice(0, 200),
    };
}
