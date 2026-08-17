/**
 * The dashboard's one write path, kept out of the route file so it can be tested with a plain
 * `Request` instead of a running server. The route is the thin door; this is the behaviour.
 */
import { registryPath } from "@app/spotify/lib/paths";
import { profileAdd, profileList, profileRemove, profileUse } from "@app/spotify/lib/reports/profiles";
import { jsonBody, requireSameOrigin } from "@app/spotify/ui/server/api-utils";

const ACTIONS = ["add", "use", "remove"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * `action` is untyped at runtime. Defaulting anything unrecognised to `add` meant a client
 * sending `"delete"` would silently create or overwrite a registry entry and get a 200 back.
 */
export function parseAction(action: string | undefined): Action {
    const which = (action ?? "add") as Action;
    if (!ACTIONS.includes(which)) {
        throw new Error(`unknown action "${action}". Pick one of: ${ACTIONS.join(", ")}`);
    }

    return which;
}

/**
 * A typed `jsonBody<T>` is a TypeScript assertion and nothing more: at runtime the payload is
 * whatever the client sent. A `tz` of `["Europe/Prague"]` would be persisted into profiles.json
 * and then throw from `toLocaleString` on every later report, a long way from here.
 */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
    const value = body[key];
    // Only an ABSENT field counts as omitted. Treating an explicit `null` as omitted let
    // `{ "action": null }` fall through to the "add" default and overwrite a profile, which is
    // the same silent mutation the action check exists to prevent.
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new Error(`"${key}" must be a string`);
    }

    return value;
}

/** Throws on anything invalid; `apiHandler` turns that into a 400 carrying the message. */
export async function profileWrite(request: Request): Promise<Response> {
    requireSameOrigin(request);
    const raw = await jsonBody<unknown>(request);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("the request body must be a JSON object");
    }

    const body = raw as Record<string, unknown>;
    const name = stringField(body, "name")?.trim();
    if (!name) {
        throw new Error('missing required "name"');
    }

    const action = parseAction(stringField(body, "action"));
    if (action === "use") {
        profileUse(name);
    } else if (action === "remove") {
        profileRemove(name);
    } else {
        // `profileAdd` validates the timezone and the name itself, so both doors get that check.
        profileAdd({
            name,
            history: stringField(body, "history"),
            data: stringField(body, "data"),
            label: stringField(body, "label"),
            tz: stringField(body, "tz"),
        });
    }

    return Response.json(profileList(registryPath()));
}
