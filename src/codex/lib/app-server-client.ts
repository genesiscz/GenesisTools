/**
 * The app-server JSON-RPC client moved to `@genesiscz/utils/ai/openai/app-server-client`
 * so the `openai-sub` plugin's `accounts.usage.poll` can start one for an account's
 * `CODEX_HOME`: `src/utils/**` may not import `@app/*`
 * (scripts/ci/check-package-boundaries.ts rule 1), and the plugin lives under `src/utils`.
 */
export type {
    AppServerProcess,
    RpcId,
    RpcNotification,
    RpcServerRequest,
} from "@genesiscz/utils/ai/openai/app-server-client";
export { AppServerClient, spawnAppServer } from "@genesiscz/utils/ai/openai/app-server-client";
