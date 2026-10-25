import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";

export const GATEWAY_HEADER = "X-Genesis-Mcp-Gateway";

/** Sent by a health probe. The gateway then neither refreshes a token nor starts a login for the request. */
export const DIAGNOSTIC_HEADER = "X-Genesis-Mcp-Diagnostic";

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";

export const DEFAULT_GATEWAY_PORT = WEB_SERVICES["mcp-gateway"].port;

export const ACCESS_SKEW_MS = 60_000;

/**
 * Redirect for servers with a pre-registered OAuth app (no dynamic registration). The
 * provider matches the redirect URL exactly, so the callback cannot use a random port.
 */
export const STATIC_CLIENT_REDIRECT_URI_DEFAULT = `http://127.0.0.1:${WEB_SERVICES["mcp-oauth-callback"].port}/callback`;

export const CLIENT_NAME_DEFAULT = "Genesis Tools (mcp-manager)";

export const REDACTED = "•••";
