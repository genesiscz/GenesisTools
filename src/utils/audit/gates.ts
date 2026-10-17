import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { redactCredentialArgs, redactCredentialFields } from "@genesiscz/utils/security/vault-purpose";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * The one audit trail of every gate a person answers or that decides for them: the vault key, an AI account's token,
 * a link that runs a saved command, Touch ID, the privacy-permission dialogs. One JSON object per line in
 * `~/.genesis-tools/audit/gates.jsonl`, readable only by its owner. The app writes the same file
 * (GenesisKit `GateAudit.swift`); both use `gate`, `event`, `at` and `writer`. Secrets are never written.
 */
export function gatesAuditPath(): string {
    return genesisToolsDir("audit", "gates.jsonl");
}

export interface GateAuditEntry {
    gate: string;
    event: string;
    [field: string]: unknown;
}

/** Appends one line. Never throws: an audit write must not stop a gate, so a failure is logged instead. */
export function appendGateAudit(entry: GateAuditEntry): void {
    const path = gatesAuditPath();

    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const created = !existsSync(path);
        const line = {
            ...entry,
            at: new Date().toISOString(),
            writer: { pid: process.pid, argv: redactCredentialArgs(process.argv).slice(1, 3) },
        };
        appendFileSync(path, `${SafeJSON.stringify(redactCredentialFields(line))}\n`, { mode: 0o600 });

        if (created) {
            chmodSync(path, 0o600);
        }
    } catch (error) {
        logger.warn({ error, path, gate: entry.gate, event: entry.event }, "gate audit: could not write the line");
    }
}
