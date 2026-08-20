/**
 * The thin, adapter-agnostic auth interface the rest of the app uses. SERVER-ONLY.
 *
 * App code (server functions, route loaders, API handlers) imports `getSessionUser` / `requireAuth`
 * from HERE — never `auth.api.*` directly. That indirection is the WorkOS swap seam: re-point these
 * functions at the WorkOS handler and nothing else changes. See `auth.server.ts` for the flag.
 */

import { auth } from "./auth.server";

export interface SessionUser {
    id: string;
    email: string;
    name: string;
}

export interface AuthService {
    /** Resolve the signed-in user from request headers, or null if anonymous. */
    getSessionUser(headers: Headers): Promise<SessionUser | null>;
    /** Like getSessionUser but throws a 401-shaped error when anonymous. */
    requireAuth(headers: Headers): Promise<SessionUser>;
    /** The raw auth handler mounted at /api/auth/* (framework boundary). */
    handler(request: Request): Promise<Response>;
}

export class UnauthorizedError extends Error {
    readonly status = 401;

    constructor(message = "Authentication required") {
        super(message);
        this.name = "UnauthorizedError";
    }
}

async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
    const result = await auth.api.getSession({ headers });

    if (!result?.user) {
        return null;
    }

    return {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
    };
}

async function requireAuth(headers: Headers): Promise<SessionUser> {
    const user = await getSessionUser(headers);

    if (!user) {
        throw new UnauthorizedError();
    }

    return user;
}

function handler(request: Request): Promise<Response> {
    return auth.handler(request);
}

export const authService: AuthService = {
    getSessionUser,
    requireAuth,
    handler,
};
