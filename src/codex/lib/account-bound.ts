/**
 * The policy of a Codex app-server that is bound to one selected account: a client may use it, but never change who it
 * runs as. The account-bound terminal (`tui-bridge.ts`) and the embed proxy for host apps (`embed-proxy.ts`) both
 * refuse these requests, so neither can undo the selected identity while the process still carries the original
 * `TOOLS_CODEX_ACCOUNT` stamp.
 */

/** The message of the JSON-RPC error a refused request gets. */
export const ACCOUNT_BOUND_REFUSAL =
    "This Codex server is bound to its selected account; login and configuration writes are unavailable";

/** The JSON-RPC error code of that refusal (invalid request). */
export const ACCOUNT_BOUND_ERROR_CODE = -32600;

const identityKeys = new Set([
    "model_provider",
    "model_providers",
    "chatgpt_base_url",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
    "cli_auth_credentials_store",
    "auth",
    "api_key",
    "experimental_bearer_token",
]);

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changesIdentity(value: unknown): boolean {
    if (Array.isArray(value)) {
        // A list is a legitimate place to hide `{model_provider: …}`, so descend into it
        // rather than treating every array as inert.
        return value.some((child) => changesIdentity(child));
    }

    if (!record(value)) {
        return false;
    }

    return Object.entries(value).some(([key, child]) =>
        key === "modelProvider"
            ? child != null && child !== "openai"
            : identityKeys.has(key.split(".")[0]) || changesIdentity(child)
    );
}

/**
 * Whether a client request would change the account the server runs as: a login, a logout, a configuration write, or
 * params anywhere in which a key names another model provider, base URL, credential store or credential.
 */
export function breaksAccountBinding(method: string, params: unknown): boolean {
    return (
        method.startsWith("account/login") ||
        method === "account/logout" ||
        (method.startsWith("config/") && !method.endsWith("/read")) ||
        changesIdentity(params)
    );
}
