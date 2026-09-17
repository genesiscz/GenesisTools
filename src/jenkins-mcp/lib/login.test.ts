/**
 * The anonymous check, pinned against a stub Jenkins.
 *
 * WHY THIS FILE EXISTS. An API token is only accepted as the password half of
 * basic auth. Verified against a real Jenkins on 2026-09-16: the same token
 * with a WRONG username answers 401, and `Authorization: Bearer <token>`
 * answers **200** with `{"anonymous":true,"name":"anonymous"}`. So a status
 * code alone does not prove a login worked, and a `verifyAuth` reduced to
 * `res.status === 200` would call an anonymous session a successful login. That
 * reduction is the easy mistake and it is invisible without this test.
 *
 * ONE SERVER FOR THE WHOLE FILE. `bun run test` charges ~368 ms per test FILE
 * and this one spawns a listener; it stays one `Bun.serve` on an ephemeral port
 * shared by every case, routed by the username it was called with, rather than
 * a server per assertion.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { verifyAuth } from "./login";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        fetch(req) {
            const auth = req.headers.get("authorization") ?? "";

            // Bearer is the shape that reaches Jenkins as anonymous: it answers
            // 200 and names nobody, which is exactly what must NOT pass.
            if (auth.startsWith("Bearer ")) {
                return Response.json({ anonymous: true, name: "anonymous" });
            }

            const [user] = Buffer.from(auth.replace(/^Basic /, ""), "base64")
                .toString("utf8")
                .split(":");

            if (user === "wrong-user") {
                return new Response("no", { status: 401 });
            }

            if (user === "anon-user") {
                return Response.json({ id: "anonymous", fullName: "anonymous" });
            }

            if (user === "teapot") {
                return new Response("short and stout", { status: 418 });
            }

            return Response.json({ id: user, fullName: "Someone Real" });
        },
    });
    base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
    server.stop(true);
});

describe("verifyAuth", () => {
    test("accepts a token that resolves to a named user", async () => {
        expect(await verifyAuth({ url: base, user: "someone", token: "t0ken" })).toEqual({
            id: "someone",
            fullName: "Someone Real",
        });
    });

    test("rejects an id of 'anonymous' even though Jenkins answered 200", async () => {
        const err = await verifyAuth({ url: base, user: "anon-user", token: "t0ken" }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("anonymous");
        expect((err as Error).message).toContain("did not accept");
    });

    test("rejects a wrong username with the token, which Jenkins answers 401", async () => {
        const err = await verifyAuth({ url: base, user: "wrong-user", token: "t0ken" }).catch((e: unknown) => e);

        expect((err as Error).message).toContain("rejected that username and token");
        expect((err as Error).message).toContain("401");
    });

    test("an unexpected status is reported rather than treated as a login", async () => {
        const err = await verifyAuth({ url: base, user: "teapot", token: "t0ken" }).catch((e: unknown) => e);

        expect((err as Error).message).toContain("418");
    });
});
