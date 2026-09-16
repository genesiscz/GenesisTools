import { describe, expect, test } from "bun:test";
import { createLoginLauncher } from "./auto-login.ts";

/** Resolve on the next macrotask, so an un-awaited launcher body has run to completion. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

describe("the gateway starts one login per server", () => {
    test("the first request starts a login and notifies", async () => {
        const logins: string[] = [];
        const notified: string[] = [];
        const launcher = createLoginLauncher({
            login: async (server) => {
                logins.push(server);
            },
            notify: async (server) => {
                notified.push(server);
            },
        });

        expect(launcher.request("wisprflow")).toBe("started");
        await settle();

        expect(logins).toEqual(["wisprflow"]);
        expect(notified).toEqual(["wisprflow"]);
    });

    test("a second request while one is in flight does not open a second login", async () => {
        const gate = deferred<void>();
        let calls = 0;
        const launcher = createLoginLauncher({
            login: async () => {
                calls += 1;
                await gate.promise;
            },
            notify: async () => undefined,
        });

        expect(launcher.request("wisprflow")).toBe("started");
        await settle();

        expect(launcher.request("wisprflow")).toBe("in-flight");
        expect(launcher.pending("wisprflow")).toBe(true);
        expect(calls).toBe(1);

        gate.resolve();
        await settle();

        expect(launcher.pending("wisprflow")).toBe(false);
    });

    test("a different server is not blocked by another server's login", async () => {
        const gate = deferred<void>();
        const logins: string[] = [];
        const launcher = createLoginLauncher({
            login: async (server) => {
                logins.push(server);
                await gate.promise;
            },
            notify: async () => undefined,
        });

        launcher.request("wisprflow");
        await settle();

        expect(launcher.request("rohlik")).toBe("started");
        await settle();

        expect(logins).toEqual(["wisprflow", "rohlik"]);
        gate.resolve();
    });
});

describe("the authorization URL stays reachable", () => {
    test("the launcher keeps the URL the login reported", async () => {
        const launcher = createLoginLauncher({
            login: async (_server, report) => {
                report("https://issuer.example/authorize?code_challenge=x");
            },
            notify: async () => undefined,
        });

        expect(launcher.authorizationUrl("wisprflow")).toBeUndefined();

        launcher.request("wisprflow");
        await settle();

        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/authorize?code_challenge=x");
    });

    test("a login that failed after reporting still leaves the URL", async () => {
        const launcher = createLoginLauncher({
            login: async (_server, report) => {
                report("https://issuer.example/authorize");

                throw new Error("No authorization callback");
            },
            notify: async () => undefined,
        });

        launcher.request("wisprflow");
        await settle();

        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/authorize");
    });

    test("each server keeps its own URL", async () => {
        const launcher = createLoginLauncher({
            login: async (server, report) => {
                report(`https://issuer.example/authorize?server=${server}`);
            },
            notify: async () => undefined,
        });

        launcher.request("wisprflow");
        launcher.request("rohlik");
        await settle();

        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/authorize?server=wisprflow");
        expect(launcher.authorizationUrl("rohlik")).toBe("https://issuer.example/authorize?server=rohlik");
    });
});

describe("a login held by another process counts as in flight", () => {
    test("no login starts while another process holds one, and its URL is exposed", async () => {
        let calls = 0;
        const launcher = createLoginLauncher({
            login: async () => {
                calls += 1;
            },
            notify: async () => undefined,
            pending: () => ({ url: "https://issuer.example/authorize?held=elsewhere" }),
        });

        expect(launcher.request("wisprflow")).toBe("in-flight");
        await settle();

        expect(calls).toBe(0);
        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/authorize?held=elsewhere");
    });

    test("the URL of a login held elsewhere is readable before any request", () => {
        const launcher = createLoginLauncher({
            login: async () => undefined,
            notify: async () => undefined,
            pending: (server) => (server === "wisprflow" ? { url: "https://issuer.example/a" } : undefined),
        });

        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/a");
        expect(launcher.authorizationUrl("rohlik")).toBeUndefined();
    });

    test("a login starts normally once nothing is held elsewhere", async () => {
        let held: { url?: string } | undefined = { url: "https://issuer.example/a" };
        let calls = 0;
        const launcher = createLoginLauncher({
            login: async () => {
                calls += 1;
            },
            notify: async () => undefined,
            pending: () => held,
        });

        expect(launcher.request("wisprflow")).toBe("in-flight");

        held = undefined;
        expect(launcher.request("wisprflow")).toBe("started");
        await settle();

        expect(calls).toBe(1);
    });
});

describe("a failed login is not retried on every reconnect", () => {
    test("the cooldown blocks the next request and expires on its own", async () => {
        let clock = 1_000;
        let calls = 0;
        const errors: string[] = [];
        const launcher = createLoginLauncher({
            login: async () => {
                calls += 1;

                throw new Error("No authorization callback");
            },
            notify: async () => undefined,
            onError: (server) => errors.push(server),
            now: () => clock,
            cooldownMs: 60_000,
        });

        expect(launcher.request("wisprflow")).toBe("started");
        await settle();

        expect(calls).toBe(1);
        expect(errors).toEqual(["wisprflow"]);
        expect(launcher.request("wisprflow")).toBe("cooling-down");

        clock += 59_999;
        expect(launcher.request("wisprflow")).toBe("cooling-down");

        clock += 2;
        expect(launcher.request("wisprflow")).toBe("started");
        await settle();

        expect(calls).toBe(2);
    });

    test("a successful login leaves no cooldown behind", async () => {
        let clock = 1_000;
        let calls = 0;
        const launcher = createLoginLauncher({
            login: async () => {
                calls += 1;
            },
            notify: async () => undefined,
            now: () => clock,
        });

        launcher.request("wisprflow");
        await settle();

        clock += 10;
        expect(launcher.request("wisprflow")).toBe("started");
        await settle();

        expect(calls).toBe(2);
    });
});
