import { createHash, timingSafeEqual } from "node:crypto";
import { type AuthFn, UnauthenticatedError, extractBearerToken } from "eve/channels/auth";

/**
 * Optional per-user service-key auth for the eve agent's HTTP routes.
 *
 * eve protects routes with an ordered auth walk on the channel factory
 * (`agent/channels/eve.ts`), not a Nitro `server/middleware/` file — that slot
 * does not exist in eve's project layout. This module is the eve-native
 * equivalent of `src/youtube/lib/server/auth.ts` (`requireServiceKey`): it
 * returns an {@link AuthFn} that gates `/eve/v1/session*` while eve keeps
 * `GET /eve/v1/health` (always public) and `/.well-known/workflow/*` (not a
 * channel route) unauthenticated.
 *
 * Enabled only when at least one key is configured via `EVE_SERVICE_KEY`
 * (a comma-separated list — one key per user). When no key is configured the
 * agent stays open, so `eve dev` and localhost use are unaffected.
 *
 * apps/eve is an isolated subproject, so this reads `process.env` directly
 * (the parent repo's env facade is intentionally not imported here).
 */

/** Split the comma-separated key list into individual keys, dropping blanks. */
export function parseServiceKeys(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/**
 * Resolve the configured service keys, failing closed when the value is present
 * but yields no usable keys. A missing/empty value keeps the agent open so
 * localhost development is unaffected. A value that is present but parses to
 * zero keys (e.g. `",,,"`) throws instead of silently falling back to open
 * mode, so a typo'd `EVE_SERVICE_KEY` can't quietly expose every route.
 */
export function resolveServiceKeys(raw: string | undefined): string[] {
  const keys = parseServiceKeys(raw);

  if (raw && raw.trim().length > 0 && keys.length === 0) {
    throw new Error("EVE_SERVICE_KEY is set but contains no valid service keys (check for stray commas)");
  }

  return keys;
}

/**
 * Hash both sides to fixed 32-byte SHA-256 digests before comparing: a raw
 * length guard before timingSafeEqual would leak the configured keys' lengths
 * via loop timing. Digests are always equal length, so the compare never varies
 * with the presented token's length. No early-exit so a valid key later in the
 * list is not distinguishable by timing from one earlier.
 */
export function tokenMatchesAny(presented: string, keys: string[]): boolean {
  const presentedHash = createHash("sha256").update(presented).digest();
  let matched = false;

  for (const key of keys) {
    const keyHash = createHash("sha256").update(key).digest();

    if (timingSafeEqual(presentedHash, keyHash)) {
      matched = true;
    }
  }

  return matched;
}

const OPEN_CONTEXT = {
  attributes: {},
  authenticator: "service-key-open",
  principalId: "eve-open",
  principalType: "anonymous",
} as const;

const ACCEPTED_CONTEXT = {
  attributes: {},
  authenticator: "service-key",
  principalId: "eve-service-key",
  principalType: "service",
} as const;

/**
 * Route-auth entry for `eveChannel({ auth: [serviceKeyAuth()] })`.
 *
 * - No keys configured: accepts every request (open mode).
 * - Keys configured + valid `Authorization: Bearer <key>`: accepts.
 * - Keys configured + missing/wrong key: throws a structured 401.
 *
 * Keys are resolved once when the factory is called (channel module load),
 * mirroring the youtube server's start-time resolution.
 */
export function serviceKeyAuth(): AuthFn<Request> {
  const keys = resolveServiceKeys(process.env.EVE_SERVICE_KEY);

  return (request) => {
    if (keys.length === 0) {
      return OPEN_CONTEXT;
    }

    const token = extractBearerToken(request.headers.get("authorization"));

    if (token && tokenMatchesAny(token, keys)) {
      return ACCEPTED_CONTEXT;
    }

    // Log the decision — never the presented key — so auth failures are
    // triageable, distinguishing a missing key from a wrong one.
    const { method } = request;
    const path = new URL(request.url, "http://localhost").pathname;
    console.warn(`eve auth: rejected ${method} ${path} (${token ? "invalid-key" : "no-key"})`);

    throw new UnauthenticatedError({
      code: "authentication_required",
      message: "Invalid or missing eve service key.",
      challenges: [{ scheme: "Bearer" }],
    });
  };
}
