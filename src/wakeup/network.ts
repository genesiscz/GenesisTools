import { networkInterfaces } from "node:os";

export interface InterfaceDetails {
    id: string;
    name: string;
    address: string;
    netmask: string;
    mac: string;
    broadcast: string;
}

function ipToInt(ip: string): number {
    const octets = ip.split(".").map((part) => Number.parseInt(part, 10));

    if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
        return 0;
    }

    return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function intToIp(value: number): string {
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function calculateBroadcast(address: string, netmask: string): string {
    const addrInt = ipToInt(address);
    const maskInt = ipToInt(netmask);

    if (addrInt === 0 || maskInt === 0) {
        return "255.255.255.255";
    }

    const broadcastInt = addrInt | (~maskInt >>> 0);
    return intToIp(broadcastInt);
}

export function listInterfaces(): InterfaceDetails[] {
    const entries = networkInterfaces();
    const results: InterfaceDetails[] = [];

    for (const [name, infos] of Object.entries(entries)) {
        if (!infos) {
            continue;
        }

        for (const info of infos) {
            if (info.internal || info.family !== "IPv4" || !info.address || !info.netmask || !info.mac) {
                continue;
            }

            const broadcast = calculateBroadcast(info.address, info.netmask);
            const id = `${name}-${info.address}`;

            results.push({
                id,
                name,
                address: info.address,
                netmask: info.netmask,
                mac: info.mac.toLowerCase(),
                broadcast,
            });
        }
    }

    return results;
}

export function getDefaultInterface(): InterfaceDetails | undefined {
    const interfaces = listInterfaces();

    if (interfaces.length === 0) {
        return undefined;
    }

    return interfaces[0];
}
