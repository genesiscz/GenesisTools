import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aiDataDir } from "@genesiscz/utils/ai/config/paths";
import { appendGateAudit } from "@genesiscz/utils/audit/gates";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import { parseJSON, SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isJsonObject, readJsonFileForUpdateSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import type { ClientIdentity, GateGrant, GateProvider, TokenKind, VaultGrant } from "./types";

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

function isGrantsFile(value: unknown): value is GrantsFile {
    return isJsonObject(value) && Array.isArray(value.grants);
}

/**
 * The grants a write starts from. A file that exists but does not parse is copied aside first
 * (`grants.json.corrupt-<time>`), so remembering or revoking a grant never destroys the only copy of
 * the user's approvals. A read error other than a missing file throws, and nothing is written.
 */
function readGrantsFileForUpdate(path: string): GrantsFile {
    const existing = readJsonFileForUpdateSync(path, { accepts: isGrantsFile });

    return existing.state === "ok" ? existing.value : { version: 1, grants: [] };
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
            const current = readGrantsFileForUpdate(path).grants.filter((grant) => isLive(grant, now));
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

export function vaultGrantsPath(): string {
    return join(gateDir(), "vault-grants.json");
}

function isVaultGrant(value: unknown): value is VaultGrant {
    return isJsonObject(value) && typeof value.key === "string" && typeof value.tool === "string";
}

function readVaultGrants(): VaultGrant[] {
    const path = vaultGrantsPath();
    if (!existsSync(path)) {
        return [];
    }

    const parsed = parseJSON<{ grants?: unknown[] }>(readFileSync(path, "utf8"));
    return (parsed?.grants ?? []).filter(isVaultGrant);
}

/** Vault-key approvals GenesisTools.app remembers that have not ended. */
export function listVaultGrants(now = Date.now()): VaultGrant[] {
    return readVaultGrants().filter((grant) => grant.until === null || grant.until > now);
}

/** Drop vault-key approvals by tool name or key; `"*"` drops every one. The app writes this file by atomic rename. */
export async function revokeVaultGrants(selector: string): Promise<number> {
    const path = vaultGrantsPath();
    let removed = 0;

    if (!existsSync(path)) {
        return 0;
    }

    await withFileLock(
        `${path}.lock`,
        async () => {
            const grants = readVaultGrants();
            const kept = grants.filter(
                (grant) => selector !== "*" && grant.key !== selector && grant.tool !== selector
            );
            removed = grants.length - kept.length;
            atomicWriteFileSync(path, `${SafeJSON.stringify({ version: 1, grants: kept }, null, 2)}\n`, {
                mode: 0o600,
            });
        },
        10_000
    );

    return removed;
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
    // The shared trail of every gate (src/utils/audit/gates.ts) gets the same decision.
    appendGateAudit({ gate: "ai-account", ...entry });
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
