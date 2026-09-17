import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { autoLoginRefusal, createLoginLauncher } from "./auto-login.ts";
import { loginSpawnArgs } from "./login-runner.ts";
import { gatewayRepoRoot } from "./service.ts";

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
    test("the URL is visible while the login is in flight and gone after success", async () => {
        const gate = deferred<void>();
        const launcher = createLoginLauncher({
            login: async (_server, report) => {
                report("https://issuer.example/authorize?code_challenge=x");
                await gate.promise;
            },
            notify: async () => undefined,
        });

        expect(launcher.authorizationUrl("wisprflow")).toBeUndefined();

        launcher.request("wisprflow");
        await settle();

        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/authorize?code_challenge=x");
        expect(launcher.userCode("wisprflow")).toBeUndefined();

        gate.resolve();
        await settle();

        expect(launcher.authorizationUrl("wisprflow")).toBeUndefined();
    });

    test("a device user_code stays reachable with the URL while in flight", async () => {
        const gate = deferred<void>();
        const launcher = createLoginLauncher({
            login: async (_server, report) => {
                report("https://identity.example/activate", "ABCD-EFGH");
                await gate.promise;
            },
            notify: async () => undefined,
        });

        launcher.request("wisprflow");
        await settle();

        expect(launcher.authorizationUrl("wisprflow")).toBe("https://identity.example/activate");
        expect(launcher.userCode("wisprflow")).toBe("ABCD-EFGH");

        gate.resolve();
        await settle();

        expect(launcher.userCode("wisprflow")).toBeUndefined();
    });

    test("a later request after success does not echo the spent authorize URL", async () => {
        let reported = "https://issuer.example/authorize?old=1";
        const launcher = createLoginLauncher({
            login: async (_server, report) => {
                if (reported) {
                    report(reported);
                }
            },
            notify: async () => undefined,
        });

        launcher.request("wisprflow");
        await settle();
        expect(launcher.authorizationUrl("wisprflow")).toBeUndefined();

        reported = "";
        expect(launcher.request("wisprflow")).toBe("started");
        expect(launcher.authorizationUrl("wisprflow")).toBeUndefined();
        await settle();
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

    test("each server keeps its own URL while in flight", async () => {
        const gate = deferred<void>();
        const launcher = createLoginLauncher({
            login: async (server, report) => {
                report(`https://issuer.example/authorize?server=${server}`);
                await gate.promise;
            },
            notify: async () => undefined,
        });

        launcher.request("wisprflow");
        launcher.request("rohlik");
        await settle();

        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/authorize?server=wisprflow");
        expect(launcher.authorizationUrl("rohlik")).toBe("https://issuer.example/authorize?server=rohlik");
        gate.resolve();
        await settle();
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
        expect(launcher.authorizationUrl("wisprflow")).toBeUndefined();
        await settle();

        expect(calls).toBe(1);
    });

    test("a new login after an external pending login does not echo the spent URL", async () => {
        let held: { url?: string } | undefined = { url: "https://issuer.example/spent" };
        const gate = deferred<void>();
        const launcher = createLoginLauncher({
            login: async (_server, report) => {
                report("https://issuer.example/fresh");
                await gate.promise;
            },
            notify: async () => undefined,
            pending: () => held,
        });

        expect(launcher.request("wisprflow")).toBe("in-flight");
        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/spent");

        held = undefined;
        expect(launcher.request("wisprflow")).toBe("started");
        expect(launcher.authorizationUrl("wisprflow")).toBeUndefined();
        await settle();
        expect(launcher.authorizationUrl("wisprflow")).toBe("https://issuer.example/fresh");
        gate.resolve();
        await settle();
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

    test("a notification failure does not skip login or start the cooldown", async () => {
        const clock = 1_000;
        let calls = 0;
        const errors: string[] = [];
        const launcher = createLoginLauncher({
            login: async () => {
                calls += 1;
            },
            notify: async () => {
                throw new Error("notification rejected");
            },
            onError: (server) => errors.push(server),
            now: () => clock,
            cooldownMs: 60_000,
        });

        expect(launcher.request("wisprflow")).toBe("started");
        await settle();

        expect(calls).toBe(1);
        expect(errors).toEqual([]);
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

describe("auto-login refuses a preset that needs an interactive client_name", () => {
    test("Figma without a stored clientName is refused", () => {
        const reason = autoLoginRefusal("design", {
            type: "http",
            url: "https://mcp.figma.com/mcp",
            auth: { kind: "oauth", gateway: true },
        });

        expect(reason).toContain("interactive client_name");
        expect(reason).toContain("auth login design");
    });

    test("Figma with a stored clientName can be launched", () => {
        expect(
            autoLoginRefusal("design", {
                type: "http",
                url: "https://mcp.figma.com/mcp",
                auth: { kind: "oauth", gateway: true, clientName: "Claude Code (genesis-tools)" },
            })
        ).toBeUndefined();
    });

    test("a server without a preset is not refused", () => {
        expect(
            autoLoginRefusal("shop", {
                type: "http",
                url: "https://mcp.shop.example/mcp",
                auth: { kind: "oauth", gateway: true },
            })
        ).toBeUndefined();
    });
});

describe("the gateway spawns mcp-manager directly", () => {
    test("login argv is the tool entrypoint, not the tools wrapper", () => {
        const args = loginSpawnArgs("wisprflow");

        expect(args[0]?.endsWith("src/mcp-manager/index.ts")).toBe(true);
        expect(args.slice(1)).toEqual(["auth", "login", "wisprflow"]);
        expect(args.includes("tools")).toBe(false);
    });

    test("a stored client_name is passed through", () => {
        const args = loginSpawnArgs("design", "Claude Code (genesis-tools)");

        expect(args.slice(-2)).toEqual(["--client-name", "Claude Code (genesis-tools)"]);
    });

    test("gatewayRepoRoot finds this checkout", () => {
        const root = gatewayRepoRoot();

        expect(existsSync(join(root, "package.json"))).toBe(true);
        expect(existsSync(join(root, "tools"))).toBe(true);
        expect(existsSync(join(root, "src/mcp-manager/index.ts"))).toBe(true);
    });
});
