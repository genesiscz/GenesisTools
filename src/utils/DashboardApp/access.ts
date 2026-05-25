import { logger, out } from "@app/logger";
import { Browser } from "@app/utils/browser";
import { getLocalIpv4 } from "@app/utils/network";
import { type QrOptions, renderQr } from "@app/utils/qr";
import pc from "picocolors";
import { waitForUrlReady } from "./readiness";
import type { DashboardAppConfig, DashboardQrOption } from "./types";

export interface PresentDashboardAccessOpts {
    url: string;
    label?: string;
    qr?: DashboardQrOption;
}

export interface OpenDashboardAccessOpts extends PresentDashboardAccessOpts {
    openBrowser?: boolean;
    readyTimeoutMs?: number;
}

export function defaultLanDashboardUrl(port: number, path = "/"): string {
    return `http://${getLocalIpv4()}:${port}${path}`;
}

export function resolveDashboardAccessPresentation(
    config: DashboardAppConfig,
    port: number,
    overrides?: { url?: string }
): PresentDashboardAccessOpts {
    const url = overrides?.url ?? config.access?.url?.(port) ?? defaultLanDashboardUrl(port);

    return {
        url,
        label: config.access?.label,
        qr: config.access?.qr,
    };
}

export function presentDashboardAccess(opts: PresentDashboardAccessOpts): void {
    const label = opts.label ?? "dashboard";

    out.printlnErr("");
    out.printlnErr(`  ${pc.bold(pc.yellow(`${label}:`))} ${pc.bold(opts.url)}`);

    if (!opts.qr) {
        return;
    }

    const qrOpts: QrOptions = typeof opts.qr === "object" ? opts.qr : { small: true };

    out.printlnErr("");
    out.printlnErr(pc.dim("  scan from your phone:"));
    out.printlnErr(renderQr(opts.url, qrOpts));
}

export async function openDashboardAccess(opts: OpenDashboardAccessOpts): Promise<void> {
    presentDashboardAccess(opts);

    if (opts.openBrowser === false) {
        return;
    }

    const ready = await waitForUrlReady(opts.url, opts.readyTimeoutMs ?? 10_000);
    if (!ready.ready) {
        out.printlnErr(`error: Dashboard page not ready (${ready.detail ?? "timeout"}).`);
        out.printlnErr(pc.dim(`  open manually: ${opts.url}`));
        process.exit(1);
    }

    await Browser.open(opts.url).catch((err) => {
        logger.debug({ err, url: opts.url }, "dashboard access: browser open failed");
    });
}
