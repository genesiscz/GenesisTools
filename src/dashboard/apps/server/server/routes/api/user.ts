import { createError, eventHandler, getHeader } from "h3";

export default eventHandler(async (event) => {
    // Get authorization header
    const authHeader = getHeader(event, "authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw createError({
            statusCode: 401,
            statusMessage: "Unauthorized",
            message: "Missing or invalid authorization header",
        });
    }

    // TODO: Verify WorkOS token and return user info
    // For now, return a placeholder
    return {
        id: "user_placeholder",
        email: "user@example.com",
        name: "Dashboard User",
        authenticated: false,
        message: "WorkOS token verification not yet implemented",
    };
});
