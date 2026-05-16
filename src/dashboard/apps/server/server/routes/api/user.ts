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

    // Fail closed until WorkOS token verification is implemented — never
    // return a placeholder user for an unverified Bearer token.
    throw createError({
        statusCode: 501,
        statusMessage: "Not Implemented",
        message: "WorkOS token verification is not implemented yet",
    });
});
