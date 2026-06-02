type Tier = "lan" | "tailscale" | "cloudflared-self" | "managed";

/**
 * The base URL the pairing flow targets. Defaults to the canonical local Agent on :3042 so an
 * unconfigured run behaves exactly as before. Override with `DD_TEST_AGENT` to point the whole
 * suite at a side-port Agent (e.g. a current-branch `tools dev-dashboard agent --port 3142` that
 * serves the newer `/api/*` routes the live :3042 build does not):
 *
 *   DD_TEST_AGENT=http://127.0.0.1:3142 bun run e2e
 *
 * The sim shares the host loopback, so `127.0.0.1:<port>` reaches the Mac directly.
 */
export const TEST_AGENT_BASE_URL = process.env.DD_TEST_AGENT ?? "http://127.0.0.1:3042";

/** Build the `devdashboard://pair?...` deep-link URI for the configured test Agent. */
export function pairingUri({ tier = "cloudflared-self", username = "martin", baseUrl = TEST_AGENT_BASE_URL }: { tier?: Tier; username?: string; baseUrl?: string } = {}): string {
    return `devdashboard://pair?tier=${tier}&baseUrl=${encodeURIComponent(baseUrl)}&username=${encodeURIComponent(username)}`;
}
