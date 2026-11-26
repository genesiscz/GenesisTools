import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

const { log } = logger.scoped("publish-audit");
const MAX_AUDIT_BYTES = 10 * 1024 * 1024;
const AUDIT_FILES = 10;
export const AUDIT_FILE = "audit.jsonl";

const AuditSchema = z.object({
    time: z.string(),
    side: z.enum(["server", "client"]),
    action: z.enum([
        "request",
        "admin",
        "pair",
        "re-pair",
        "publish",
        "send",
        "remove",
        "prune",
        "forget",
        "token-read",
        "token-check",
    ]),
    address: z.string().optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    kind: z.string().optional(),
    id: z.string().optional(),
    deviceId: z.string().optional(),
    deviceName: z.string().optional(),
    target: z.string().optional(),
    status: z.number().int(),
    bytesOut: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative(),
    userAgent: z.string().optional(),
});

export type AuditRecord = z.infer<typeof AuditSchema>;
type ClientAuditLabel = Pick<AuditRecord, "action" | "target" | "kind" | "id" | "deviceId">;

function scrub(value?: string, sensitive?: readonly string[]): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    // Remove secrets before truncating so a short field cannot retain a partial secret.
    const clean = (sensitive ?? []).filter(Boolean).reduce((text, word) => text.replaceAll(word, "[redacted]"), value);
    return clean
        .replaceAll(/\bgtshare_[A-Za-z0-9_-]+/g, "[redacted]")
        .replaceAll(/\b[a-f0-9]{64}\b/gi, "[redacted]")
        .replaceAll(/\b([A-HJ-KM-NP-Z2-9]{2})[A-HJ-KM-NP-Z2-9]{2}-[A-HJ-KM-NP-Z2-9]{4}\b/gi, "$1…");
}

export function clientAddress(
    peer?: string,
    forwarded?: string | null,
    options: { trustProxy?: boolean } = {}
): string | undefined {
    // Reverse proxies append their peer to the chain. Earlier entries may have been supplied by the client.
    if (options.trustProxy && (peer === "127.0.0.1" || peer === "::1")) {
        const supplied = forwarded?.split(",").at(-1)?.trim();
        if (supplied && isIP(supplied)) {
            return supplied;
        }
    }

    return peer && isIP(peer) ? peer : undefined;
}

function auditPath(dir: string, generation = 0): string {
    return join(dir, generation ? `${AUDIT_FILE}.${generation}` : AUDIT_FILE);
}

async function missingOk<T>(operation: Promise<T>): Promise<T | undefined> {
    try {
        return await operation;
    } catch (err) {
        if (!isMissingPathError(err)) {
            throw err;
        }

        return undefined;
    }
}

async function restrictAuditFile(path: string): Promise<void> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        await file.chmod(0o600);
    } finally {
        await file.close();
    }
}

async function rotate(dir: string): Promise<void> {
    for (let slot = AUDIT_FILES - 1; slot > 0; slot--) {
        await missingOk(restrictAuditFile(auditPath(dir, slot - 1)));
        await missingOk(rename(auditPath(dir, slot - 1), auditPath(dir, slot)));
    }
}

export async function recordAudit(
    dir: string,
    input: AuditRecord,
    options: { sensitive?: readonly string[]; maxBytes?: number } = {}
): Promise<void> {
    const { sensitive, maxBytes = MAX_AUDIT_BYTES } = options;
    const record = AuditSchema.parse({
        ...input,
        path: scrub(input.path?.split("?")[0], sensitive)?.slice(0, 1000),
        method: scrub(input.method, sensitive)?.slice(0, 32),
        kind: scrub(input.kind, sensitive),
        id: scrub(input.id, sensitive),
        target: scrub(input.target, sensitive),
        deviceId: scrub(input.deviceId, sensitive),
        deviceName: scrub(input.deviceName, sensitive)?.slice(0, 80),
        userAgent: scrub(input.userAgent, sensitive)?.slice(0, 200),
    });
    log.debug(record, "publish audit");

    const path = auditPath(dir);
    const line = `${SafeJSON.stringify(record)}\n`;
    try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await withFileLock(`${path}.lock`, async () => {
            const existing = await missingOk(lstat(path));
            if (existing && !existing.isFile()) {
                throw new Error("Audit path is not a regular file");
            }

            if (existing && (existing.mode & 0o777) !== 0o600) {
                await restrictAuditFile(path);
            }

            if (existing?.size && existing.size + Buffer.byteLength(line) > maxBytes) {
                await rotate(dir);
            }

            const file = await open(
                path,
                constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
                0o600
            );
            try {
                if (existing && (existing.mode & 0o777) !== 0o600) {
                    await file.chmod(0o600);
                }

                await file.writeFile(line);
            } finally {
                await file.close();
            }
        });
    } catch (err) {
        log.warn({ err, dir }, "could not append publish audit file");
    }
}

export function clientAuditDir(): string {
    return toolDataDir("share");
}

export async function auditClientOperation<T>(
    label: ClientAuditLabel,
    run: () => Promise<T>,
    result: (value: T) => Partial<Pick<AuditRecord, "status" | "id" | "deviceId">> = () => ({})
): Promise<T> {
    const started = Date.now();
    const clock = performance.now();
    let details: Partial<Pick<AuditRecord, "status" | "id" | "deviceId">> = {};
    let status = 500;
    try {
        const value = await run();
        details = result(value);
        status = details.status ?? 200;
        return value;
    } catch (err) {
        if (err instanceof Error && "status" in err && typeof err.status === "number") {
            status = err.status;
        }

        throw err;
    } finally {
        await recordAudit(clientAuditDir(), {
            ...label,
            ...details,
            time: new Date(started).toISOString(),
            side: "client",
            status,
            durationMs: performance.now() - clock,
        });
    }
}

export async function readAudit(
    dir: string,
    options: { since?: Date; device?: string; accepts?: (record: AuditRecord) => boolean; limit?: number } = {}
): Promise<AuditRecord[]> {
    const records: AuditRecord[] = [];
    const since = options.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    for (let generation = 0; generation < AUDIT_FILES; generation++) {
        const text = await missingOk(readFile(auditPath(dir, generation), "utf8"));
        const lines = text?.split("\n") ?? [];
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) {
                continue;
            }

            try {
                const checked = AuditSchema.safeParse(SafeJSON.parse(line, { strict: true }));
                if (!checked.success) {
                    continue;
                }

                const entry = checked.data;
                if (
                    Date.parse(entry.time) < since ||
                    (options.device && entry.deviceId !== options.device) ||
                    (options.accepts && !options.accepts(entry))
                ) {
                    continue;
                }

                records.push(entry);
                if (options.limit !== undefined && records.length >= options.limit) {
                    return records.reverse();
                }
            } catch {
                log.debug({ generation }, "skipped unreadable publish audit line");
            }
        }
    }

    return records.reverse();
}
