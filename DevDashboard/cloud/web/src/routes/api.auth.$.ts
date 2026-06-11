import { createFileRoute } from "@tanstack/react-router";
import { authService } from "@/lib/auth/auth-service";

/** Better-Auth's catch-all handler, mounted at /api/auth/* (sign-up, sign-in, session, sign-out). */
export const Route = createFileRoute("/api/auth/$")({
    server: {
        handlers: {
            GET: ({ request }) => authService.handler(request),
            POST: ({ request }) => authService.handler(request),
        },
    },
});
