/**
 * Profiles are the one thing the dashboard writes. Pointing a profile at a different
 * export or harvest directory is the whole reason the settings page exists, so the same
 * three verbs the CLI has are reachable here. The behaviour lives in `server/profile-write.ts`
 * so it can be tested without a server; this file is the door.
 */
import { registryPath } from "@app/spotify/lib/paths";
import { profileList } from "@app/spotify/lib/reports/profiles";
import { apiHandler } from "@app/spotify/ui/server/api-utils";
import { profileWrite } from "@app/spotify/ui/server/profile-write";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/profiles")({
    server: {
        handlers: {
            GET: apiHandler(() => Response.json(profileList(registryPath()))),
            POST: apiHandler(({ request }) => profileWrite(request)),
        },
    },
});
