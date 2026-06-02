import { useEffect, useState } from "react";
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

    useEffect(() => {
        const zeroconf = new Zeroconf();

        const startScan = (): void => {
            setScanning(true);
            zeroconf.scan(SERVICE_TYPE, "tcp", "local.");
        };

        zeroconf.on("resolved", (service: Service) => {
            const agent = toAgent(service);

            if (agent) {
                setAgents((prev) => (prev.some((a) => a.baseUrl === agent.baseUrl) ? prev : [...prev, agent]));
            }
        });

        zeroconf.on("error", () => setScanning(false));
        startScan();

        const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
            if (next === "active") {
                setAgents([]);
                zeroconf.stop();
                startScan();
            }
        });

        return () => {
            sub.remove();
            zeroconf.stop();
            zeroconf.removeDeviceListeners();
        };
    }, []);

    return { agents, scanning, rescan: () => setAgents([]) };
}
