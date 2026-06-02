import { logger } from "@app/logger";
import Bonjour from "bonjour-service";

// Advertises the Agent as `_devdashboard._tcp` over Bonjour/mDNS so the mobile LAN
// tier can discover it on the same Wi-Fi (DECISIONS D6). Uses `bonjour-service` (D20,
// user pick) — pure-JS, programmatic, cross-platform (works if the Agent later runs on
// Linux), no `dns-sd` subprocess to babysit.

export interface MdnsRegisterOptions {
    instanceName: string;
    port: number;
    /** Bonjour service type WITHOUT the `_` prefix / `._tcp` suffix (advertised as `_<type>._tcp`). */
    serviceType?: string;
    txt?: Record<string, string>;
}

export interface MdnsServiceConfig {
    name: string;
    type: string;
    port: number;
    protocol: "tcp";
    txt: Record<string, string>;
}

const DEFAULT_SERVICE_TYPE = "devdashboard";

/** Pure: the `bonjour.publish()` config. Unit-tested; the publish() call wraps this. */
export function buildServiceConfig(opts: MdnsRegisterOptions): MdnsServiceConfig {
    return {
        name: opts.instanceName,
        type: opts.serviceType ?? DEFAULT_SERVICE_TYPE,
        port: opts.port,
        protocol: "tcp",
        txt: { path: "/", ...(opts.txt ?? {}) },
    };
}

export interface MdnsAdvertiser {
    stop(): void;
}

/** Publish the Agent over Bonjour. Returns a stop handle (sends mDNS goodbye, then closes the socket). */
export function startMdnsAdvertiser(opts: MdnsRegisterOptions): MdnsAdvertiser {
    const config = buildServiceConfig(opts);
    let instance: Bonjour | null = null;

    try {
        instance = new Bonjour();
        instance.publish(config);
        logger.info(
            { port: config.port, service: `_${config.type}._${config.protocol}` },
            "dev-dashboard: mDNS advertiser started (bonjour-service)"
        );
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: mDNS advertiser failed to start (LAN discovery disabled)");
    }

    return {
        stop() {
            const current = instance;

            if (!current) {
                return;
            }

            try {
                current.unpublishAll(() => current.destroy());
            } catch (err) {
                logger.debug({ err }, "dev-dashboard: mDNS advertiser stop failed");
            }
        },
    };
}
