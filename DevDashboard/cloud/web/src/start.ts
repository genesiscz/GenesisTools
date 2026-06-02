import { createStart } from "@tanstack/react-start";

// No request middleware: Better-Auth manages sessions via its own handler
// (server/lib/auth.ts mounted at /api/auth/*). If we ever swap to WorkOS, this
// is where authkitMiddleware() would go (see src/dashboard/apps/web/src/start.ts).
export const startInstance = createStart(() => {
    return {};
});
