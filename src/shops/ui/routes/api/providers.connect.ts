import { KosikAuthClient } from "@app/shops/api/shops/KosikAuthClient";
import { RohlikAuthClient } from "@app/shops/api/shops/RohlikAuthClient";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { apiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/connect")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const shop = body.shop_origin;
                const credentials = body.credentials as Record<string, unknown> | undefined;
                if (typeof shop !== "string" || !credentials) {
                    return Response.json({ error: "shop_origin and credentials are required" }, { status: 400 });
                }

                const repo = new UserProvidersRepository(getShopsDatabase());

                if (shop === "rohlik.cz") {
                    const email = credentials.email;
                    const password = credentials.password;
                    if (typeof email !== "string" || typeof password !== "string") {
                        return Response.json({ error: "rohlik requires email + password" }, { status: 400 });
                    }

                    const client = new RohlikAuthClient();
                    try {
                        await client.login(email, password);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : "login failed";
                        return Response.json({ error: msg, code: "login_failed" }, { status: 401 });
                    }

                    const profile = await client.getProfile();
                    const id = await repo.connect({
                        user_id: 1,
                        shop_origin: "rohlik.cz",
                        credentials: { type: "email-password", email, password },
                        external_user_email: profile.email,
                    });
                    return Response.json({
                        ok: true,
                        user_provider_id: id,
                        external_user_email: profile.email,
                    });
                }

                if (shop === "kosik.cz") {
                    const cookieRaw = credentials.cookie ?? credentials.sid;
                    if (typeof cookieRaw !== "string" || cookieRaw.length === 0) {
                        return Response.json({ error: "kosik requires cookie (sid value)" }, { status: 400 });
                    }

                    const cookie = cookieRaw.startsWith("sid=") ? cookieRaw : `sid=${cookieRaw}`;
                    const client = new KosikAuthClient({ sessionCookie: cookie });
                    let profile: Awaited<ReturnType<typeof client.getProfile>>;
                    try {
                        profile = await client.getProfile();
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : "session invalid";
                        return Response.json({ error: msg, code: "session_invalid" }, { status: 401 });
                    }

                    const id = await repo.connect({
                        user_id: 1,
                        shop_origin: "kosik.cz",
                        credentials: { type: "session-cookie", cookie },
                        external_user_email: profile.client.email,
                    });
                    return Response.json({
                        ok: true,
                        user_provider_id: id,
                        external_user_email: profile.client.email,
                    });
                }

                return Response.json({ error: `unsupported shop_origin: ${shop}` }, { status: 400 });
            }),
        },
    },
});
