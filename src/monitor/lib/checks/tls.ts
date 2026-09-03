import { connect as tlsConnect } from "node:tls";
import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, Watcher } from "../types";
import { parseHostPort } from "./tcp";

export const DEFAULT_TLS_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CertificateInfo {
    subject: string | null;
    issuer: string | null;
    validTo: Date;
}

export function daysUntil(date: Date, now: number = Date.now()): number {
    return Math.floor((date.getTime() - now) / DAY_MS);
}

/** Verdict for a certificate that is `days` from expiry, given the watcher's thresholds. */
export function judgeCertificate(
    days: number,
    config: Pick<Watcher["config"], "warnDays" | "minDays">
): { status: CheckResult["status"]; note: string } {
    const minDays = config.minDays ?? 0;
    const warnDays = config.warnDays ?? DEFAULT_TLS_WARN_DAYS;

    if (days < 0) {
        return { status: "down", note: `expired ${-days} day${days === -1 ? "" : "s"} ago` };
    }

    if (days < minDays) {
        return { status: "down", note: `${days} days left, below the ${minDays}-day minimum` };
    }

    if (days < warnDays) {
        return { status: "degraded", note: `${days} days left, renew soon (warn below ${warnDays})` };
    }

    return { status: "up", note: `${days} days left` };
}

function fetchCertificate(host: string, port: number, timeoutMs: number): Promise<CertificateInfo> {
    return new Promise((resolve, reject) => {
        const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true }, () => {
            const cert = socket.getPeerCertificate();
            socket.end();

            if (!cert || !cert.valid_to) {
                reject(new Error("no certificate presented"));

                return;
            }

            resolve({
                subject: cert.subject?.CN ?? null,
                issuer: cert.issuer?.O ?? cert.issuer?.CN ?? null,
                validTo: new Date(cert.valid_to),
            });
        });
        socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            reject(new Error(`no TLS handshake within ${Math.round(timeoutMs / 1000)} s`));
        });
        socket.on("error", (error: Error) => {
            socket.destroy();
            reject(error);
        });
    });
}

/**
 * Completes a verified TLS handshake and reads the leaf certificate's expiry.
 * A chain the system trust store rejects (self-signed, wrong host) is `down`
 * with the OpenSSL reason, which is what a browser would show too.
 */
export async function checkTls(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    let hostPort: { host: string; port: number };

    try {
        hostPort = parseHostPort(watcher.target, 443);
    } catch (error) {
        return {
            status: "unknown",
            latencyMs: null,
            httpStatus: null,
            detail: `bad target: ${(error as Error).message}`,
        };
    }

    const started = performance.now();
    let cert: CertificateInfo;

    try {
        cert = await fetchCertificate(hostPort.host, hostPort.port, watcher.timeoutMs);
    } catch (error) {
        logger.debug({ error, target: watcher.target }, "monitor: tls handshake failed");
        const message = error instanceof Error ? error.message : String(error);

        return { status: "down", latencyMs: null, httpStatus: null, detail: `${hostPort.host}: ${message}` };
    }

    const latencyMs = Math.round(performance.now() - started);
    const days = daysUntil(cert.validTo);
    const verdict = judgeCertificate(days, watcher.config);
    const until = cert.validTo.toISOString().slice(0, 10);

    return {
        status: verdict.status,
        latencyMs,
        httpStatus: null,
        detail: `${cert.subject ?? hostPort.host} valid until ${until} (${verdict.note})${cert.issuer ? ` · ${cert.issuer}` : ""}`,
        meta: { validTo: cert.validTo.toISOString(), daysLeft: days, issuer: cert.issuer, subject: cert.subject },
    };
}
