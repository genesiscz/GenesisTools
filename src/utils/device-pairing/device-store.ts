import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import { type PairedDevice, PairedDeviceSchema } from "./types";

const { log } = logger.scoped("device-pairing");

const DevicesFileSchema = z.object({ version: z.literal(1), devices: z.array(PairedDeviceSchema) });

/** No 0/O, 1/I/L: a code is read off one screen and typed on another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes in a row before every pending code is dropped, so a code cannot be guessed. */
export const MAX_PAIR_FAILURES = 5;
/** `lastUsedAt` is written at most this often, so each upload does not rewrite the file. */
const LAST_USED_RESOLUTION_MS = 60 * 60_000;

export function hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeCode(code: string): string {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function makeCode(): string {
    return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

export interface DeviceStoreOptions {
    file: string;
    tokenPrefix: string;
    now?: () => number;
}

/**
 * The devices that may access this service. Each holds a token the server stores only as a hash; a device
 * gets its token by trading a one-time pairing code (`createPairingCode`), which lives in this process's memory only.
 */
export class DeviceStore {
    private pending: Array<{ codeHash: string; expiresAt: number }> = [];
    private failures = 0;

    private readonly file: string;
    private readonly tokenPrefix: string;
    private readonly now: () => number;

    constructor(options: DeviceStoreOptions) {
        this.file = options.file;
        this.tokenPrefix = options.tokenPrefix;
        this.now = options.now ?? Date.now;
    }

    createPairingCode(ttlMs = PAIR_CODE_TTL_MS): { code: string; expiresAt: string } {
        const code = makeCode();
        const expiresAt = this.now() + ttlMs;
        this.pending = this.pending.filter((entry) => entry.expiresAt > this.now());
        this.pending.push({ codeHash: hashToken(code), expiresAt });
        this.failures = 0;

        return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(expiresAt).toISOString() };
    }

    /** Trade a pairing code for a new device and its token; null for a wrong, used or expired code. */
    async pair(code: string, deviceName: string): Promise<{ deviceId: string; token: string } | null> {
        const codeHash = hashToken(normalizeCode(code));
        const at = this.now();
        const match = this.pending.find((entry) => entry.expiresAt > at && safeEqual(entry.codeHash, codeHash));

        if (!match) {
            this.failures++;

            if (this.failures >= MAX_PAIR_FAILURES) {
                log.warn({ failures: this.failures }, "too many wrong pairing codes; dropping every pending code");
                this.pending = [];
                this.failures = 0;
            }

            return null;
        }

        this.pending = this.pending.filter((entry) => entry !== match);
        const token = `${this.tokenPrefix}${randomBytes(32).toString("base64url")}`;
        const device: PairedDevice = {
            id: randomBytes(6).toString("hex"),
            name: deviceName,
            tokenHash: hashToken(token),
            createdAt: new Date(at).toISOString(),
        };
        await this.withWriteLock(async () => this.write([...(await this.read()), device]));
        log.info({ deviceId: device.id, deviceName }, "share device paired");

        return { deviceId: device.id, token };
    }

    /** Identify a token for a read-only request, without recording use. */
    async identify(token: string): Promise<PairedDevice | null> {
        return findDevice(await this.read(), hashToken(token));
    }

    /** Identify a token and record its use, at most once per hour. */
    async authenticate(token: string): Promise<PairedDevice | null> {
        const tokenHash = hashToken(token);
        const device = findDevice(await this.read(), tokenHash);

        if (!device || !this.usageIsDue(device)) {
            return device;
        }

        return this.withWriteLock(async () => {
            const devices = await this.read();
            const current = findDevice(devices, tokenHash);

            if (current && this.usageIsDue(current)) {
                const usedAt = new Date(this.now()).toISOString();
                await this.write(
                    devices.map((entry) => (entry.id === current.id ? { ...entry, lastUsedAt: usedAt } : entry))
                );
            }

            return current;
        });
    }

    private usageIsDue(device: PairedDevice): boolean {
        const last = device.lastUsedAt ? Date.parse(device.lastUsedAt) : 0;
        return this.now() - last > LAST_USED_RESOLUTION_MS;
    }

    async list(): Promise<PairedDevice[]> {
        return this.read();
    }

    async revoke(id: string): Promise<boolean> {
        return this.withWriteLock(async () => {
            const devices = await this.read();
            const next = devices.filter((device) => device.id !== id);

            if (next.length === devices.length) {
                return false;
            }

            await this.write(next);
            log.info({ deviceId: id }, "share device revoked");

            return true;
        });
    }

    private async read(): Promise<PairedDevice[]> {
        const raw = await readFile(this.file, "utf8").catch((err: unknown) => {
            if (!isMissingPathError(err)) {
                throw err;
            }

            return null;
        });

        if (raw === null) {
            return [];
        }

        return DevicesFileSchema.parse(SafeJSON.parse(raw, { strict: true })).devices;
    }

    private async withWriteLock<T>(write: () => Promise<T>): Promise<T> {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        return withFileLock(`${this.file}.lock`, write);
    }

    private async write(devices: PairedDevice[]): Promise<void> {
        const temp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(temp, SafeJSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
        await rename(temp, this.file);
    }
}

function findDevice(devices: readonly PairedDevice[], tokenHash: string): PairedDevice | null {
    return devices.find((entry) => safeEqual(entry.tokenHash, tokenHash)) ?? null;
}

function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);

    return left.length === right.length && timingSafeEqual(left, right);
}
