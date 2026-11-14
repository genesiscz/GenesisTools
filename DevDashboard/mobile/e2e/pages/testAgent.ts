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
export function pairingUri({ tier = "cloudflared-self", username = "e2e", baseUrl = TEST_AGENT_BASE_URL }: { tier?: Tier; username?: string; baseUrl?: string } = {}): string {
    return `devdashboard://pair?tier=${tier}&baseUrl=${encodeURIComponent(baseUrl)}&username=${encodeURIComponent(username)}`;
}

/**
 * Taps Pair on the pair screen a pairing link opened and waits for where a successful pair goes: `src/app/pair.tsx`
 * replaces the route with the tabs, so the pair screen leaves and the Pulse root shows. Throws when the agent asks for
 * a password or a code, the screen shows an error, or the app never leaves it, so a spec never runs against the
 * connection the app had before the link.
 */
export async function confirmPairing(timeout = 20_000): Promise<void> {
    const confirm = await $("~pair-confirm");
    await confirm.waitForDisplayed({ timeout: 15_000 });
    await confirm.click();

    await browser.waitUntil(
        async () =>
            !(await $("~pair-screen").isExisting()) ||
            (await $("~pair-error").isExisting()) ||
            (await $("~pair-ask").isExisting()),
        { timeout, timeoutMsg: "the pair screen never closed after Pair" }
    );

    const error = await $("~pair-error");

    if (await error.isExisting()) {
        throw new Error(`pairing failed: ${await error.getText()}`);
    }

    if (await $("~pair-ask").isExisting()) {
        throw new Error("the agent asks for a password or a device code; the e2e pairing needs one that does not");
    }

    await $("~screen-pulse").waitForExist({ timeout, timeoutMsg: "the app left the pair screen but never showed the tabs" });
}
