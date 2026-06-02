/**
 * Server functions that bridge the auth-service into TanStack Start route loaders / components.
 * These run on the server (createServerFn) and read the live request via getRequest().
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { authService, type SessionUser } from "./auth-service";

/** Returns the signed-in user or null. Safe to call from anonymous routes. */
export const getMe = createServerFn({ method: "GET" }).handler(async (): Promise<SessionUser | null> => {
    const request = getRequest();
    return authService.getSessionUser(request.headers);
});
