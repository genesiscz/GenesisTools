import dgram from "node:dgram";

export interface WakeOptions {
    mac: string;
    broadcast?: string;
    port?: number;
    password?: string;
}

export interface WakeResult {
    broadcast: string;
    port: number;
    mac: string;
    bytesSent: number;
}

/** Parse a 6-byte hex string (separators allowed) into bytes, or throw with `label` context. */
function parseHex6(raw: string, label: string): Uint8Array {
    const cleaned = raw.replace(/[^0-9a-fA-F]/g, "");

    if (cleaned.length !== 12) {
        throw new Error(`Invalid ${label} "${raw}". Expected 6 bytes (12 hex chars).`);
    }

    const bytes = new Uint8Array(6);

    for (let i = 0; i < 6; i++) {
        bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }

    return bytes;
}

function parseMac(mac: string): Uint8Array {
    return parseHex6(mac, "MAC address");
}

function parsePassword(password: string | undefined): Uint8Array | null {
    if (!password) {
        return null;
    }

    return parseHex6(password, "SecureOn password");
}

export function buildMagicPacket(macBytes: Uint8Array, passwordBytes: Uint8Array | null): Buffer {
    const header = new Uint8Array(6).fill(0xff);
    const body = new Uint8Array(macBytes.length * 16);

    for (let i = 0; i < 16; i++) {
        body.set(macBytes, i * macBytes.length);
    }

    const totalLength = header.length + body.length + (passwordBytes ? passwordBytes.length : 0);
    const packet = new Uint8Array(totalLength);

    packet.set(header, 0);
    packet.set(body, header.length);

    if (passwordBytes) {
        packet.set(passwordBytes, header.length + body.length);
    }

    return Buffer.from(packet);
}

export async function sendWakePacket(opts: WakeOptions): Promise<WakeResult> {
    const macBytes = parseMac(opts.mac);
    const passwordBytes = parsePassword(opts.password);
    const packet = buildMagicPacket(macBytes, passwordBytes);

    const broadcast = opts.broadcast ?? "255.255.255.255";
    const port = opts.port ?? 9;

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        // NaN passes plain range checks (all comparisons false) — reject it explicitly.
        throw new Error(`Invalid UDP port "${port}".`);
    }

    const socket = dgram.createSocket("udp4");

    return new Promise<WakeResult>((resolve, reject) => {
        socket.once("error", (err) => {
            socket.close();
            reject(err);
        });

        socket.bind(0, () => {
            try {
                socket.setBroadcast(true);
            } catch (err) {
                socket.close();
                reject(err);
                return;
            }

            socket.send(packet, port, broadcast, (err, bytes) => {
                socket.close();

                if (err) {
                    reject(err);
                    return;
                }

                resolve({
                    broadcast,
                    port,
                    mac: opts.mac.toLowerCase(),
                    bytesSent: bytes,
                });
            });
        });
    });
}
