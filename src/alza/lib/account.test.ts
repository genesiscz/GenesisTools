import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ImpersonatedHttpClient,
    type ImpersonatedRequest,
    type ImpersonatedResponse,
} from "@genesiscz/utils/http/impersonate/client";
import { SafeJSON } from "@genesiscz/utils/json";
import { browserOpener } from "../commands/account";
import { alzaMcpTools } from "../mcp/tools";
import {
    type AccountContext,
    accountStatus,
    findCartLine,
    parseCart,
    parseOrders,
    parseWatchdogDialog,
    parseWatchdogList,
    toOrderSummary,
    userId,
} from "./account";
import { orderDocument, validateDocumentUrl } from "./account-extras";
import { findAccountOperation } from "./account-operations";
import { gridOrderSchema, type StoredTokens, watchdogDialogSchema, watchdogListSchema } from "./account-schemas";
import { AlzaApi } from "./api";
import { AlzaAuth, isExpiring, jwtExpiryMs, NotSignedInError, parseRedirect, pkceChallenge } from "./auth";
import { splitSetCookie, statePath, VisitorSession } from "./state";
import { STOREFRONTS } from "./storefront";

/** Answers every request from `answer` and records it; never touches the network or the curl worker. */
class CannedHttp extends ImpersonatedHttpClient {
    readonly requests: ImpersonatedRequest[] = [];

    constructor(
        private readonly answer: (req: ImpersonatedRequest) => ImpersonatedResponse | Promise<ImpersonatedResponse>
    ) {
        super({ label: "test" });
    }

    override async request(req: ImpersonatedRequest): Promise<ImpersonatedResponse> {
        this.requests.push(req);
        return this.answer(req);
    }
}

const ok = (req: ImpersonatedRequest, body: unknown, headers: Record<string, string> = {}): ImpersonatedResponse => ({
    status: 200,
    url: req.url,
    headers,
    text: SafeJSON.stringify(body),
});

const VISITOR = "11111111-2222-4333-8444-555555555555";

function tempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function tokens(access: string, refresh: string, expiresAt: string): StoredTokens {
    return {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_at: expiresAt,
        obtained_at: "2026-11-01T10:00:00Z",
    };
}

function writeTokens(path: string, value: StoredTokens): void {
    writeFileSync(path, SafeJSON.stringify(value));
}

function accountContext(http: CannedHttp, dir: string): AccountContext {
    const session = VisitorSession.load(join(dir, "visitor.json"));
    const auth = new AlzaAuth({
        http,
        storefront: STOREFRONTS.cz,
        visitorId: session.visitorId,
        tokensFile: join(dir, "tokens.json"),
        pendingFile: join(dir, "pending.json"),
    });
    const api = new AlzaApi({
        http,
        visitorId: session.visitorId,
        cookies: session,
        accessToken: () => auth.accessToken(),
    });
    return { api, auth, session };
}

const WATCHDOG = "0f1e2d3c-4b5a-4968-8776-655443322110";

describe("sign-in helpers", () => {
    test("PKCE S256 matches the RFC 7636 appendix B vector", () => {
        expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    });

    test("parseRedirect takes the full redirect, a query or a bare code", () => {
        expect(parseRedirect("alza://identity?code=abc123&state=st&scope=openid")).toEqual({
            code: "abc123",
            state: "st",
        });
        expect(parseRedirect("  code=xyz&state=s2 ")).toEqual({ code: "xyz", state: "s2" });
        expect(parseRedirect("BARECODE")).toEqual({ code: "BARECODE" });
        expect(() => parseRedirect("alza://identity?error=access_denied")).toThrow("access_denied");
        expect(() => parseRedirect("alza://identity?state=only")).toThrow("no `code`");
        expect(() => parseRedirect("   ")).toThrow();
    });

    test("jwtExpiryMs reads exp and ignores opaque tokens", () => {
        const payload = Buffer.from('{"exp":1800000000,"sub":"alice"}').toString("base64url");
        expect(jwtExpiryMs(`e30.${payload}.sig`)).toBe(1_800_000_000_000);
        expect(jwtExpiryMs("opaque-token")).toBeUndefined();
        expect(jwtExpiryMs("a.not-base64-json.c")).toBeUndefined();
    });

    test("isExpiring renews a minute early and trusts a token with no expiry", () => {
        const now = Date.parse("2026-11-01T10:00:00Z");
        expect(isExpiring({ expires_at: "2026-11-01T10:00:30Z" }, now)).toBe(true);
        expect(isExpiring({ expires_at: "2026-11-01T10:05:00Z" }, now)).toBe(false);
        expect(isExpiring({}, now)).toBe(false);
    });
});

describe("visitor cookies", () => {
    test("splitSetCookie keeps the comma inside expires", () => {
        const header =
            "lb_id=abc; expires=Sun, 01-Nov-26 06:47:37 GMT; max-age=7200; httponly; path=/, " +
            "VST=11111111-2222-4333-8444-555555555555; domain=.alza.cz; expires=Mon, 01-Nov-2027 04:47:37 GMT; path=/, " +
            "IDOX=first+/=; domain=.alza.cz; path=/, IDOX=second=; domain=.alza.cz; path=/";
        const cookies = splitSetCookie(header, Date.parse("2026-11-01T00:00:00Z"));
        expect(cookies.map((c) => c.name)).toEqual(["lb_id", "VST", "IDOX", "IDOX"]);
        expect(cookies[2]?.value).toBe("first+/=");
        expect(cookies.every((c) => !c.expired)).toBe(true);
    });

    test("splitSetCookie marks deleted cookies", () => {
        const [maxAge, past] = splitSetCookie("IDOX=x; max-age=0, VST=y; expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(maxAge?.expired).toBe(true);
        expect(past?.expired).toBe(true);
    });

    test("each storefront keeps its own visitor; the legacy file is read as the Czech one and moved on save", () => {
        const dir = tempDir("alza-visitors");
        const legacy = join(dir, "state.json");
        writeFileSync(legacy, SafeJSON.stringify({ visitorId: VISITOR, cookies: { IDOX: "czech" } }));
        const cz = VisitorSession.load(join(dir, "cz.json"), legacy);
        expect(cz.visitorId).toBe(VISITOR);
        expect(cz.header()).toBe("IDOX=czech");
        cz.save();
        expect(VisitorSession.load(join(dir, "cz.json")).header()).toBe("IDOX=czech");
        const sk = VisitorSession.load(join(dir, "sk.json"));
        expect(sk.header()).toBeUndefined();
        expect(sk.visitorId).not.toBe(VISITOR);
        expect(statePath("sk")).not.toBe(statePath("cz"));
    });

    test("the session keeps only the visitor cookies, the last value winning", () => {
        const session = VisitorSession.load("/nonexistent/alza-state-for-test.json");
        expect(session.header()).toBeUndefined();
        session.absorb("lb_id=lb; path=/, IDOX=one; path=/, IDOX=two; path=/, VST=v; path=/");
        expect(session.header()).toBe("IDOX=two; VST=v");
        session.absorb("IDOX=gone; max-age=0");
        expect(session.header()).toBe("VST=v");
    });
});

describe("basket", () => {
    const grid = gridOrderSchema.parse({
        user_id: -1,
        price_pay: "2 368 Kč",
        pricePayAmt: 2368,
        data: [
            {
                orderItemId: 101,
                commodityId: 9383715,
                code: "AUPR65708",
                name: "Alkohol tester",
                count: 1,
                priceVat: "2 249 Kč",
                pricePerItemVat: "2 249 Kč",
                availability: [{ AvailAbility: "Skladem" }],
            },
            { orderItemId: 102, parentId: 101, code: "SL1EWdCZ", name: "Warranty +1", count: 1, priceVat: "119 Kč" },
            { orderItemId: 103, commodityId: 5303618, code: "HRAif8315", name: "Toy", count: 2, priceNoCurrency: 60 },
        ],
    });

    test("parseCart lists product lines and skips the services hanging under them", () => {
        const cart = parseCart(grid, { signedIn: false, currency: "CZK" });
        expect(cart.items.map((i) => i.code)).toEqual(["AUPR65708", "HRAif8315"]);
        expect(cart.itemCount).toBe(3);
        expect(cart.total).toBe(2368);
        expect(cart.items[0]).toMatchObject({ unitPrice: 2249, lineTotal: 2249, availability: "Skladem" });
        expect(cart.items[1]).toMatchObject({ unitPrice: 60, lineTotal: 120 });
    });

    test("an empty basket keeps Alza's message", () => {
        const cart = parseCart(gridOrderSchema.parse({ data: null, msg: "Jsem tak prázdný..." }), {
            signedIn: false,
            currency: "CZK",
        });
        expect(cart.items).toEqual([]);
        expect(cart.message).toBe("Jsem tak prázdný...");
    });

    test("findCartLine matches a code, an id or a URL", () => {
        const cart = parseCart(grid, { signedIn: false, currency: "CZK" });
        expect(findCartLine(cart, "aupr65708")?.orderItemId).toBe(101);
        expect(findCartLine(cart, "5303618")?.orderItemId).toBe(103);
        expect(findCartLine(cart, "https://www.alza.cz/x-d9383715.htm")?.orderItemId).toBe(101);
        expect(findCartLine(cart, "NOPE1")).toBeUndefined();
    });
});

describe("watchdogs", () => {
    test("parseWatchdogList reads id, product, price and the alert condition", () => {
        const raw = watchdogListSchema.parse({
            value: [
                {
                    commodityName: "Alkohol tester",
                    commodityUrl: "https://www.alza.cz/x-d9383715.htm",
                    priceInfoV2: { priceNoCurrency: 2249 },
                    availabilityText: "Skladem",
                    updateForm: {
                        href: `https://webapi.alza.cz/api/watchdog/v1/${WATCHDOG}?country=CZ`,
                        value: [
                            { name: "isTrackingStock", value: true },
                            { name: "price", value: 1999 },
                        ],
                    },
                },
            ],
            paging: { next: { href: "https://www.alza.cz/next" } },
        });
        expect(parseWatchdogList(raw)).toEqual({
            items: [
                {
                    id: WATCHDOG,
                    productId: 9383715,
                    name: "Alkohol tester",
                    url: "https://www.alza.cz/x-d9383715.htm",
                    currentPrice: 2249,
                    availability: "Skladem",
                    trackingStock: true,
                    maxPrice: 1999,
                },
            ],
            hasMore: true,
            empty: undefined,
        });
    });

    test("parseWatchdogDialog finds an existing watchdog and the form limits", () => {
        const existing = parseWatchdogDialog(
            watchdogDialogSchema.parse({
                form: {
                    href: "https://webapi.alza.cz/api/watchdog/v1",
                    value: [
                        { name: "email", value: "alice@example.com" },
                        { name: "price", value: null, max: 2249 },
                    ],
                },
                deleteAction: { form: { href: `https://webapi.alza.cz/api/watchdog/v1/${WATCHDOG}` } },
            })
        );
        expect(existing).toEqual({ exists: true, existingId: WATCHDOG, email: "alice@example.com", priceMax: 2249 });
        expect(parseWatchdogDialog(watchdogDialogSchema.parse({ form: null, deleteAction: null }))).toEqual({
            exists: false,
            existingId: undefined,
            email: undefined,
            priceMax: undefined,
        });
    });
});

describe("orders", () => {
    test("toOrderSummary reads the order detail shape", () => {
        expect(
            toOrderSummary({
                orderId: "1058423434",
                orderNumber: "1058 423 434",
                orderName: "Objednávka 1058 423 434",
                created: "2026-09-15T17:32:23.46Z",
                parts: [{ partNumber: "1058423434", status: "Objednávka byla zrušena" }],
            })
        ).toEqual({
            id: "1058423434",
            number: "1058 423 434",
            name: "Objednávka 1058 423 434",
            created: "2026-09-15T17:32:23.46Z",
            status: "Objednávka byla zrušena",
            total: undefined,
            parts: [{ number: "1058423434", name: undefined, status: "Objednávka byla zrušena" }],
        });
    });

    test("toOrderSummary falls back to the self link and skips an item without any id", () => {
        expect(toOrderSummary({ self: { href: "https://www.alza.cz/api/users/42/v1/orders/1058000001/" } })?.id).toBe(
            "1058000001"
        );
        expect(toOrderSummary({ orderName: "?" })).toBeUndefined();
    });
});

describe("order lists and documents", () => {
    test("a documents entry of another shape drops the documents, not the order", () => {
        const { orders } = parseOrders(
            { value: [{ orderId: "1058423434", documents: [{ name: 42, self: { value: [{ value: "no name" }] } }] }] },
            "search"
        );
        expect(orders.map((o) => o.id)).toEqual(["1058423434"]);
        expect(orders[0]?.documents).toBeUndefined();
    });

    test("a document link is pdf.alza.cz, or a route of one order on the other hosts", () => {
        expect(validateDocumentUrl("https://pdf.alza.cz/any/path/invoice.pdf").hostname).toBe("pdf.alza.cz");
        expect(validateDocumentUrl("https://www.alza.cz/api/users/42/v1/orders/1058423434/documents/1").pathname).toBe(
            "/api/users/42/v1/orders/1058423434/documents/1"
        );
        expect(() => validateDocumentUrl("https://www.alza.cz/services/restservice.svc/v4/sendOrder1")).toThrow(
            /not an order document route/
        );
        expect(() => validateDocumentUrl("https://webapi.alza.cz/api/users/42/v1/orders/active")).toThrow(
            /not an order document route/
        );
        expect(() => validateDocumentUrl("https://example.com/api/users/42/v1/orders/1058423434")).toThrow(
            /not an Alza document host/
        );
    });
});

describe("sign-in browser opener", () => {
    test("Windows gets the URL as one argument, never through cmd.exe", () => {
        const url = "https://identity.alza.cz/connect/authorize?client_id=x&response_type=code&state=s";
        expect(browserOpener(url, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
        expect(browserOpener(url, "darwin")).toEqual(["open", [url]]);
        expect(browserOpener(url, "linux")).toEqual(["xdg-open", [url]]);
    });
});

describe("account status", () => {
    test("sends nothing until the HTTP library is installed, then checks the token once", async () => {
        const dir = tempDir("alza-status");
        const http = new CannedHttp((req) => ok(req, { user_id: 42, user_name: "Alice" }));
        const ctx = accountContext(http, dir);
        writeTokens(join(dir, "tokens.json"), tokens("access", "refresh", "2099-01-01T00:00:00Z"));

        const skipped = await accountStatus(ctx, { transportInstalled: () => false });
        expect(http.requests).toHaveLength(0);
        expect(skipped.check?.detail).toMatch(/not installed yet/);

        const checked = await accountStatus(ctx, { transportInstalled: () => true });
        expect(http.requests).toHaveLength(1);
        expect(checked.check).toMatchObject({ ok: true, userName: "Alice" });
        // The HTTP client keeps its own cookie jar across calls: the check must stay out of it too.
        expect(http.requests[0]?.noCookies).toBe(true);
        await findAccountOperation("cart_show").run(ctx, {});
        expect(http.requests[1]?.noCookies).toBeUndefined();
    });
});

describe("account identity", () => {
    test("a user id is saved only into the sign-in whose token Alza named, and never kept for the next one", async () => {
        const dir = tempDir("alza-user-id");
        const tokensFile = join(dir, "tokens.json");
        writeTokens(tokensFile, tokens("token-a", "refresh-a", "2099-01-01T00:00:00Z"));
        const http = new CannedHttp((req) => {
            if (req.headers?.authorization === "Bearer token-a") {
                // Another process signs in to account B while account A's id is on its way.
                writeTokens(tokensFile, tokens("token-b", "refresh-b", "2099-01-01T00:00:00Z"));
                return ok(req, { user_id: 41 });
            }

            return ok(req, { user_id: 42 });
        });
        const ctx = accountContext(http, dir);
        expect(await userId(ctx)).toBe(41);
        expect(ctx.auth.readTokens()?.access_token).toBe("token-b");
        expect(ctx.auth.readTokens()?.user_id).toBeUndefined();
        expect(await userId(ctx)).toBe(42);
        expect(http.requests.map((r) => r.headers?.authorization)).toEqual(["Bearer token-a", "Bearer token-b"]);
        expect(ctx.auth.readTokens()?.user_id).toBe(42);
    });
});

describe("sign-in completion", () => {
    const signIn = (dir: string, during: () => Promise<void>) => {
        const http = new CannedHttp(async (req) => {
            if (req.url.endsWith("/.well-known/openid-configuration")) {
                return { status: 404, url: req.url, headers: {}, text: "" };
            }

            await during();
            return ok(req, { access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 });
        });
        return new AlzaAuth({
            http,
            storefront: STOREFRONTS.cz,
            visitorId: VISITOR,
            tokensFile: join(dir, "tokens.json"),
            pendingFile: join(dir, "pending.json"),
        });
    };

    test("a logout during the code exchange stays a logout", async () => {
        const dir = tempDir("alza-login-logout");
        const auth: AlzaAuth = signIn(dir, async () => {
            await auth.logout();
        });
        await auth.startLogin();
        await expect(auth.completeLogin("CODE")).rejects.toThrow(/cancelled while it completed/);
        expect(existsSync(join(dir, "tokens.json"))).toBe(false);
    });

    test("a newer attempt during the exchange keeps its pending file; an untouched one signs in", async () => {
        const dir = tempDir("alza-login-newer");
        let newer = "";
        const auth: AlzaAuth = signIn(dir, async () => {
            await auth.startLogin();
            newer = readFileSync(join(dir, "pending.json"), "utf8");
        });
        await auth.startLogin();
        await expect(auth.completeLogin("CODE")).rejects.toThrow(/cancelled while it completed/);
        expect(readFileSync(join(dir, "pending.json"), "utf8")).toBe(newer);

        const plain = signIn(tempDir("alza-login-plain"), async () => {});
        await plain.startLogin();
        expect((await plain.completeLogin("CODE")).access_token).toBe("fresh");
    });
});

describe("order documents", () => {
    const DOCUMENT = "https://www.alza.cz/api/users/42/v1/orders/1058423434/documents/1";
    const textAnswer = (during: () => void) =>
        new CannedHttp((req) => {
            during();
            return { status: 200, url: req.url, headers: { "content-type": "text/plain" }, text: "invoice" };
        });

    test("a file created during the download is never replaced without overwrite", async () => {
        const dir = tempDir("alza-document");
        const output = join(dir, "invoice.txt");
        const ctx = accountContext(
            textAnswer(() => writeFileSync(output, "someone else's file")),
            dir
        );
        await expect(orderDocument(ctx, { href: DOCUMENT, output })).rejects.toThrow(/created while the document/);
        expect(readFileSync(output, "utf8")).toBe("someone else's file");

        const replacing = accountContext(
            textAnswer(() => {}),
            dir
        );
        expect((await orderDocument(replacing, { href: DOCUMENT, output, overwrite: true })).bytes).toBe(7);
        expect(readFileSync(output, "utf8")).toBe("invoice");
    });
});

describe("token renewal", () => {
    const EXPIRED = "2026-01-01T00:00:00Z";
    const renewal = (during: () => Promise<void>) =>
        new CannedHttp(async (req) => {
            if (req.url.endsWith("/.well-known/openid-configuration")) {
                return { status: 404, url: req.url, headers: {}, text: "" };
            }

            await during();
            return ok(req, { access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3600 });
        });
    const authFor = (http: CannedHttp, dir: string) =>
        new AlzaAuth({
            http,
            storefront: STOREFRONTS.cz,
            visitorId: VISITOR,
            tokensFile: join(dir, "tokens.json"),
            pendingFile: join(dir, "pending.json"),
        });

    test("a renewal writes the new tokens when nothing else changed them", async () => {
        const dir = tempDir("alza-renew");
        writeTokens(join(dir, "tokens.json"), tokens("stale", "stale-refresh", EXPIRED));
        const auth = authFor(
            renewal(async () => {}),
            dir
        );
        expect(await auth.accessToken()).toBe("renewed");
        expect(auth.readTokens()?.refresh_token).toBe("renewed-refresh");
    });

    test("a logout during the renewal stays a logout", async () => {
        const dir = tempDir("alza-renew-logout");
        writeTokens(join(dir, "tokens.json"), tokens("stale", "stale-refresh", EXPIRED));
        const other = authFor(new CannedHttp(() => ({ status: 500, url: "", headers: {}, text: "" })), dir);
        const auth = authFor(
            renewal(async () => {
                await other.logout();
            }),
            dir
        );
        await expect(auth.accessToken()).rejects.toBeInstanceOf(NotSignedInError);
        expect(existsSync(join(dir, "tokens.json"))).toBe(false);
    });

    test("a new sign-in during the renewal is not overwritten", async () => {
        const dir = tempDir("alza-renew-switch");
        writeTokens(join(dir, "tokens.json"), tokens("stale", "stale-refresh", EXPIRED));
        const auth = authFor(
            renewal(async () => {
                writeTokens(join(dir, "tokens.json"), tokens("other-account", "other-refresh", "2099-01-01T00:00:00Z"));
            }),
            dir
        );
        expect(await auth.accessToken()).toBe("other-account");
        expect(readFileSync(join(dir, "tokens.json"), "utf8")).toContain("other-account");
    });
});

describe("MCP account tools", () => {
    test("removals are annotated destructive, additions are not", () => {
        const tools = alzaMcpTools(
            accountContext(new CannedHttp(() => ({ status: 500, url: "", headers: {}, text: "" })), tempDir("alza-mcp"))
        );
        const hint = (name: string) => tools.find((t) => t.name === name)?.annotations?.destructiveHint;
        expect(["cart_remove", "watchdog_remove", "mutate_list", "order_document"].map(hint)).toEqual([
            true,
            true,
            true,
            true,
        ]);
        expect(["cart_add", "watchdog_add", "cart_show"].map(hint)).toEqual([false, false, false]);
    });

    test("two first basket adds share one visitor basket instead of each taking its own", async () => {
        const dir = tempDir("alza-first-basket");
        let issued = 0;
        const http = new CannedHttp(async (req) => {
            if (!req.url.includes("/basket/add")) {
                return ok(req, { data: [] });
            }

            await Bun.sleep(5);
            if (req.headers?.cookie?.includes("IDOX=")) {
                return ok(req, { err: 0, data: { code: "AUPR65708" } });
            }

            issued++;
            return ok(req, { err: 0, data: { code: "AUPR65708" } }, { "set-cookie": `IDOX=basket-${issued}; path=/` });
        });
        const add = findAccountOperation("cart_add");
        await Promise.all([
            add.run(accountContext(http, dir), { product: "AUPR65708" }),
            add.run(accountContext(http, dir), { product: "AUPR65708" }),
        ]);
        expect(issued).toBe(1);
        const adds = http.requests.filter((r) => r.url.includes("/basket/add"));
        expect(adds.map((r) => r.headers?.cookie)).toEqual([undefined, "IDOX=basket-1"]);
        expect(VisitorSession.load(join(dir, "visitor.json")).header()).toBe("IDOX=basket-1");
    });

    test("a basket add that fails after taking a visitor cookie still saves the cookie", async () => {
        const dir = tempDir("alza-mcp-save");
        const http = new CannedHttp((req) =>
            req.url.includes("/basket/add")
                ? ok(
                      req,
                      { err: 0, data: { code: "AUPR65708", name: "Tester" } },
                      { "set-cookie": "IDOX=fresh; path=/" }
                  )
                : { status: 500, url: req.url, headers: {}, text: "basket read failed" }
        );
        const cartAdd = alzaMcpTools(accountContext(http, dir)).find((t) => t.name === "cart_add");
        const result = await cartAdd?.call({ product: "AUPR65708" });
        expect(result?.isError).toBe(true);
        expect(VisitorSession.load(join(dir, "visitor.json")).header()).toBe("IDOX=fresh");
    });
});
