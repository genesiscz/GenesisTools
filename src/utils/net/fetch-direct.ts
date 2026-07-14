/**
 * Direct outbound fetch helper for AI upstreams (xAI, Anthropic, WHAM, …).
 *
 * Background: the `grok` CLI wrapper sets HTTPS_PROXY=socks5h://… (Nord US)
 * for grok-4.5 only. That env is inherited by Grok-spawned tool shells.
 * Bun rejects socks proxies (UnsupportedProxyProtocol; oven-sh/bun#16812)
 * and snapshots proxy env at process start — mid-process `delete process.env`
 * does not help.
 *
 * The real fix is spawn-time strip (same as ~/.config/shell/pm-no-proxy.zsh):
 *   - zsh: `bun() { env -u HTTPS_PROXY … command bun "$@"; }`
 *   - tools launcher: `envWithoutProxy()` when spawning tool children
 *
 * Call sites use this helper so intent is explicit. Once the process starts
 * without a socks proxy, plain `fetch` is fine.
 */

export async function fetchDirect(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return fetch(input, init);
}
