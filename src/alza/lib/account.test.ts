import { describe, expect, test } from "bun:test";
import { findCartLine, parseCart, parseWatchdogDialog, parseWatchdogList, toOrderSummary } from "./account";
import { gridOrderSchema, watchdogDialogSchema, watchdogListSchema } from "./account-schemas";
import { isExpiring, jwtExpiryMs, parseRedirect, pkceChallenge } from "./auth";
import { splitSetCookie, VisitorSession } from "./state";

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
