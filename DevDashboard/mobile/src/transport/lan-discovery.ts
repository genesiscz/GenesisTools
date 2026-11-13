import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import Zeroconf, { type Service } from "react-native-zeroconf";

export interface DiscoveredAgent {
    name: string;
    /** Ready for a URL authority: an IPv6 literal comes in brackets. */
    host: string;
    port: number;
    /** http://host:port */
    baseUrl: string;
}

const SERVICE_TYPE = "devdashboard";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The host to put in a URL authority. An IPv4 address first; else a routable IPv6 literal, in brackets; else the
 * mDNS host name. A link-local IPv6 address (fe80::) needs a zone the URL parser refuses, so it is never picked.
 */
export function urlHostOf(service: Pick<Service, "addresses" | "host">): string | null {
    const addresses = service.addresses ?? [];
    const ipv4 = addresses.find((address) => IPV4.test(address));

    if (ipv4) {
        return ipv4;
    }

    const ipv6 = addresses.find((address) => address.includes(":") && !address.includes("%") && !/^fe80:/i.test(address));

    if (ipv6) {
        return `[${ipv6}]`;
    }

    return service.host ? service.host.replace(/\.$/, "") : null;
}

export function toAgent(service: Service): DiscoveredAgent | null {
    const host = urlHostOf(service);

    if (!host || !service.port) {
        return null;
    }

    return { name: service.name, host, port: service.port, baseUrl: `http://${host}:${service.port}` };
}

export interface ZeroconfDiscovery {
    agents: DiscoveredAgent[];
    scanning: boolean;
    rescan: () => void;
}

/** Scans for `_devdashboard._tcp`. Re-scans on AppState resume (Android mDNS dies on lock). */
export function useZeroconfDiscovery(): ZeroconfDiscovery {
    const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
    const [scanning, setScanning] = useState(false);
    // The instance lives in a ref rather than the effect closure so `rescan` can actually reach it.
    const zeroconfRef = useRef<Zeroconf | null>(null);

    const startScan = useCallback((): void => {
        setScanning(true);
        zeroconfRef.current?.scan(SERVICE_TYPE, "tcp", "local.");
    }, []);

    const rescan = useCallback((): void => {
        zeroconfRef.current?.stop();
        setAgents([]);
        startScan();
    }, [startScan]);

    useEffect(() => {
        const zeroconf = new Zeroconf();
        zeroconfRef.current = zeroconf;

        zeroconf.on("resolved", (service: Service) => {
            const agent = toAgent(service);

            if (agent) {
                setAgents((prev) => (prev.some((a) => a.baseUrl === agent.baseUrl) ? prev : [...prev, agent]));
            }
        });

        zeroconf.on("error", () => setScanning(false));
        // `start`/`stop` are the native scan lifecycle. Without the `stop` listener a scan that ends
        // cleanly leaves the UI saying "Scanning…" forever, since only `error` ever cleared the flag.
        zeroconf.on("start", () => setScanning(true));
        zeroconf.on("stop", () => setScanning(false));
        startScan();

        const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
            if (next === "active") {
                rescan();
            }
        });

        return () => {
            sub.remove();
            zeroconf.stop();
            zeroconf.removeDeviceListeners();
            zeroconfRef.current = null;
        };
    }, [rescan, startScan]);

    return { agents, scanning, rescan };
}
