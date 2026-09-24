import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aiDataDir } from "@genesiscz/utils/ai/config/paths";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import { parseJSON, SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import type { ClientIdentity, GateGrant, GateProvider, TokenKind } from "./types";

const { log } = logger.scoped("ai-gate");

interface GrantsFile {
    version: 1;
    grants: GateGrant[];
}

export function gateDir(): string {
    return aiDataDir("gate");
}

export function grantsPath(): string {
    return join(gateDir(), "grants.json");
}

export function auditPath(): string {
    return join(gateDir(), "audit.jsonl");
}

function readGrantsFile(path: string): GrantsFile {
    if (!existsSync(path)) {
        return { version: 1, grants: [] };
    }

    const parsed = parseJSON<GrantsFile>(readFileSync(path, "utf8"));

    if (!parsed || !Array.isArray(parsed.grants)) {
        log.warn({ path }, "grants file is not the expected shape, treating it as empty");
        return { version: 1, grants: [] };
    }

    return parsed;
}

function writeGrantsFile(path: string, data: GrantsFile): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function isLive(grant: GateGrant, now: number): boolean {
    return grant.until > now;
}

/** Grants that have not expired. Expired ones are dropped on the next write, not here. */
export function listGrants(now = Date.now()): GateGrant[] {
    return readGrantsFile(grantsPath()).grants.filter((grant) => isLive(grant, now));
}

export function findGrant({
    identity,
    provider,
    accountId,
    tokenKind,
    now = Date.now(),
}: {
    identity: ClientIdentity;
    provider: GateProvider;
    accountId: string;
    /** The kind this request would hand out; a grant approved for another kind does not cover it. */
    tokenKind: TokenKind;
    now?: number;
}): GateGrant | undefined {
    return listGrants(now).find(
        (grant) =>
            grant.key === identity.key &&
            grant.provider === provider &&
            grant.accountId === accountId &&
            grant.tokenKind === tokenKind
    );
}

async function mutateGrants(fn: (grants: GateGrant[]) => GateGrant[]): Promise<void> {
    const path = grantsPath();
    mkdirSync(dirname(path), { recursive: true });
    // The grants file is not AI config, so it takes the lock primitive directly rather than an
    // `AiConfigStore` (whose lock order and migrations are for config.json and the vault).
    await withFileLock(
        `${path}.lock`,
        async () => {
            const now = Date.now();
            const current = readGrantsFile(path).grants.filter((grant) => isLive(grant, now));
            writeGrantsFile(path, { version: 1, grants: fn(current) });
        },
        10_000
    );
}

/** Replace any grant for the same client, provider and account. */
export async function rememberGrant(grant: GateGrant): Promise<void> {
    await mutateGrants((grants) => [
        ...grants.filter(
            (entry) =>
                !(entry.key === grant.key && entry.provider === grant.provider && entry.accountId === grant.accountId)
        ),
        grant,
    ]);
}

/** Drop grants by client key or client name; `"*"` drops every grant. Returns how many went. */
export async function revokeGrants(selector: string): Promise<number> {
    let removed = 0;

    await mutateGrants((grants) => {
        const kept = grants.filter(
            (grant) => selector !== "*" && grant.key !== selector && grant.clientName !== selector
        );
        removed = grants.length - kept.length;
        return kept;
    });

    return removed;
}

export interface AuditEntry {
    at: string;
    event: "prompted" | "allowed" | "denied" | "remembered" | "revoked" | "error";
    client: Pick<ClientIdentity, "name" | "pid" | "executable" | "cwd">;
    provider?: GateProvider;
    account?: string;
    detail?: string;
}

/**
 * One line per decision. The token itself is never written here: the audit answers "who asked
 * and what did Martin say", and a log that could reproduce the secret would be a second vault.
 */
export async function appendAudit(entry: AuditEntry): Promise<void> {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    await appendFile(path, `${SafeJSON.stringify(entry)}\n`, { mode: 0o600 });
    // File-only: a client that runs `tools ai gate request` reads stderr for the deny reason, so
    // the audit must not land there. `-v` promotes it to the console, and the audit file has it all.
    log.debug(
        { event: entry.event, client: entry.client.name, pid: entry.client.pid, account: entry.account },
        "gate audit"
    );
}

/** A first read window per requested line; audit lines are a few hundred bytes. */
const AUDIT_TAIL_BYTES_PER_LINE = 512;

/**
 * The last `limit` lines of the append-only audit log, reading only the end of the file: the
 * window doubles until it holds `limit` whole lines or covers the file, so `gate audit` costs
 * the same on a year of history as on a day.
 */
export async function readAuditTail(limit: number): Promise<string[]> {
    const path = auditPath();

    if (!existsSync(path)) {
        return [];
    }

    const size = Bun.file(path).size;
    let bytes = Math.max(4096, limit * AUDIT_TAIL_BYTES_PER_LINE);

    for (;;) {
        const lines = await readTailBytes(path, bytes);

        if (lines.length >= limit || bytes >= size) {
            return lines.slice(-limit);
        }

        bytes *= 2;
    }
}
