import { logger } from "@genesiscz/utils/logger";
import {
    type GenesisAppRpcOutcome,
    genesisAppRpc,
    genesisAppRpcSync,
    isGenesisAppRpcAvailable,
} from "@genesiscz/utils/macos/genesis-app-rpc";
import { currentCommandLine, currentToolName, vaultPurpose, vaultSecretAsked } from "../vault-purpose";
import { decodeMasterKey, isTestProcess, type MasterKeyProvider } from "./types";

/**
 * The vault master key through GenesisTools.app's approval window (Martin's DECISION 131 b, 2026-10-15).
 *
 * Every tool runs as its own `gt-<tool>` link of bun, and macOS keys a keychain item's access list on the executable
 * path, so each tool used to raise its own "gt-claude wants to use your confidential information" dialog with nothing
 * in it to judge. Here the app reads the item as itself (one macOS prompt, ever, naming GenesisTools) and hands the key
 * on only after its own window: WHO from the kernel (the app is this process's child), WHICH SESSION from this
 * process's environment, WHY and WHAT from the request below. A remembered approval skips the window.
 *
 * A deny throws: falling through to the keychain rung would bring back the dialog this rung exists to replace. An app
 * that cannot answer (not installed, switched off, an older build without `vault.unlock`) returns undefined, and the
 * keychain rung answers as before.
 */

/** A person reads the window and touches the sensor; the app gives up at 170 s and says so. */
export const VAULT_UNLOCK_TIMEOUT_MS = 180_000;

export interface VaultUnlockRequest {
    /** The tool as GenesisTools names it (`claude`, `say`); the app shows it beside the executable it verified. */
    tool: string;
    /** Why, in one sentence: the caller's own, else the command line. */
    purpose: string;
    /** The secret this process was reading when it needed the key (`ai/<account>/<field>`). */
    secret?: string;
    command: string;
}

export interface VaultUnlockReply {
    decision: "allow" | "deny";
    /** The keychain item as stored: base64 of the 32-byte key. Present only with "allow". */
    key?: string;
    reason?: string;
    /** True when a remembered approval answered and no window opened. */
    remembered?: boolean;
}

export class VaultKeyDeniedError extends Error {
    constructor(tool: string, reason: string) {
        super(
            `GenesisTools.app did not give the vault key to “${tool}”: ${reason}. ` +
                "Allow it in the approval window, or set GENESIS_TOOLS_NO_APP=1 to read the keychain directly."
        );
        this.name = "VaultKeyDeniedError";
    }
}

/** App errors that mean "nobody here can decide": the keychain rung answers instead. */
const FALL_THROUGH = new Set(["unavailable", "method_unknown", "handshake", "no_key"]);

export function vaultUnlockRequest(): VaultUnlockRequest {
    const command = currentCommandLine();

    return {
        tool: currentToolName(),
        purpose: vaultPurpose() ?? `run ${command}`,
        secret: vaultSecretAsked(),
        command,
    };
}

function isReply(value: unknown): value is VaultUnlockReply {
    return typeof value === "object" && value !== null && "decision" in value;
}

/** The app's answer as a key, undefined (let the next rung answer), or a thrown deny. */
export function keyFromReply(outcome: GenesisAppRpcOutcome<VaultUnlockReply>, tool: string): Buffer | undefined {
    if (!outcome.ok) {
        if (FALL_THROUGH.has(outcome.error.code)) {
            logger.debug(
                { code: outcome.error.code, message: outcome.error.message },
                "vault key: the app cannot answer"
            );
            return undefined;
        }

        throw new VaultKeyDeniedError(tool, `${outcome.error.code}: ${outcome.error.message}`);
    }

    if (outcome.result.decision !== "allow") {
        throw new VaultKeyDeniedError(tool, outcome.result.reason ?? "denied in the approval window");
    }

    const key = decodeMasterKey(outcome.result.key, "app");
    if (!key) {
        throw new VaultKeyDeniedError(tool, "the app allowed it but returned no readable key");
    }

    logger.debug({ tool, remembered: outcome.result.remembered === true }, "vault key handed down by GenesisTools.app");
    return key;
}

export interface AppGateDeps {
    available?: () => boolean;
    rpc?: (request: VaultUnlockRequest) => Promise<GenesisAppRpcOutcome<VaultUnlockReply>>;
    rpcSync?: (request: VaultUnlockRequest) => GenesisAppRpcOutcome<VaultUnlockReply>;
}

/** Tests build the rung with fakes; production uses `appGateKey`. A test process never reaches the real app. */
export function createAppGateKeyProvider(deps: AppGateDeps = {}): MasterKeyProvider {
    const available = deps.available ?? (() => !isTestProcess() && isGenesisAppRpcAvailable());
    const options = { timeoutMs: VAULT_UNLOCK_TIMEOUT_MS, isResult: isReply };
    const params = (request: VaultUnlockRequest): Record<string, unknown> => ({ ...request });
    const rpc =
        deps.rpc ??
        ((request: VaultUnlockRequest) => genesisAppRpc<VaultUnlockReply>("vault.unlock", params(request), options));
    const rpcSync =
        deps.rpcSync ??
        ((request: VaultUnlockRequest) =>
            genesisAppRpcSync<VaultUnlockReply>("vault.unlock", params(request), options));

    return {
        id: "app",
        async available() {
            return available();
        },
        async get() {
            if (!available()) {
                return undefined;
            }

            const request = vaultUnlockRequest();
            return keyFromReply(await rpc(request), request.tool);
        },
        getSync() {
            if (!available()) {
                return undefined;
            }

            const request = vaultUnlockRequest();
            return keyFromReply(rpcSync(request), request.tool);
        },
        async set() {
            throw new Error("GenesisTools.app only reads the vault key; a new key is stored by the keychain rung");
        },
    };
}

export const appGateKey: MasterKeyProvider = createAppGateKeyProvider();
