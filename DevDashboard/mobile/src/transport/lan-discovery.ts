import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import Zeroconf, { type Service } from "react-native-zeroconf";

export interface DiscoveredAgent {
    name: string;
    host: string;
    port: number;
    /** http://host:port */
    baseUrl: string;
}

const SERVICE_TYPE = "devdashboard";

function toAgent(service: Service): DiscoveredAgent | null {
    const host = service.addresses?.[0] ?? service.host;

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
