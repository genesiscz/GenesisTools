import { expect, test } from "bun:test";
import type { DomAction, DomSnapshot } from "@app/chrome-devtools/lib/dom/in-page";
import type { DomActResult } from "@app/chrome-devtools/lib/dom/page";
import { SafeJSON } from "@genesiscz/utils/json";
import { matchPage, type PageSelector, pageRefusal } from "../browser/pages";
import { createWriter, type WriterRequest, type WriterResult } from "../browser/writer";
import { type BrowserSurfaceOptions, createBrowserSurface, type DomPageDriver, type ScreenPoint } from "./browser";
import type { SurfaceCandidate, SurfaceSnapshot } from "./surface";

function domAction(overrides: Partial<DomAction> & Pick<DomAction, "id" | "node" | "kind" | "label">): DomAction {
    return { role: overrides.kind === "fill" ? "textbox" : "button", guard: `g${overrides.node}`, ...overrides };
}

function field(name: string, type = "text", secret = false) {
    return { type, name, id: "", ariaLabel: "", autocomplete: "", secret };
}

const checkout: DomSnapshot = {
    url: "https://shop.example/checkout",
    title: "Checkout",
    text: "Checkout Your order",
    actions: [
        domAction({
            id: "n1",
            node: 1,
            kind: "click",
            role: "link",
            label: "Pricing",
            href: "https://shop.example/pricing",
        }),
        domAction({ id: "n2f", node: 2, kind: "fill", label: "Email", value: "", field: field("email", "email") }),
        domAction({ id: "n3f", node: 3, kind: "fill", label: "Password", field: field("password", "password", true) }),
        domAction({ id: "n4o1", node: 4, kind: "select", label: "Shipping", option: { index: 1, label: "Express" } }),
        domAction({ id: "n5f", node: 5, kind: "fill", label: "Name", value: "Ada", field: field("name") }),
    ],
    omitted: 0,
    belowFold: 2,
    belowFoldLabels: ["Place order", "Terms of sale"],
    secretFields: [{ label: "Password", field: field("password", "password", true) }],
    canScrollDown: true,
    canScrollUp: false,
    historyLength: 1,
    marker: "m1",
};

const plain: DomSnapshot = {
    ...checkout,
    url: "http://127.0.0.1:3990/",
    title: "Jev fixture page",
    actions: [
        domAction({ id: "n1", node: 1, kind: "click", role: "link", label: "Learn more" }),
        domAction({ id: "n2", node: 2, kind: "click", label: "Export report" }),
        domAction({ id: "n3f", node: 3, kind: "fill", label: "Name", value: "", field: field("name") }),
    ],
    canScrollDown: false,
    historyLength: 3,
    marker: "p1",
    secretFields: [],
};

/** A page driver that records every call and answers success, so the surface's routing is what is tested. */
function scriptedPage(
    snapshots: DomSnapshot[],
    calls: string[],
    screen?: ScreenPoint
): DomPageDriver & { reads: number } {
    const done = (call: string): Promise<DomActResult> => {
        calls.push(call);
        return Promise.resolve({
            ok: true,
            settled: { reason: "quiet", mutations: 1, ms: 5 },
            ...(screen ? { screen } : {}),
        });
    };
    const driver = {
        reads: 0,
        snapshot: async () => snapshots[Math.min(driver.reads++, snapshots.length - 1)],
        click: (action: DomAction) => done(`click ${action.id}@${action.guard}`),
        fill: (action: DomAction, value: string) => done(`fill ${action.id}=${value}`),
        select: (action: DomAction) => done(`select ${action.id}`),
        scroll: (direction: 1 | -1) => done(`scroll ${direction}`),
        wait: () => done("wait"),
        back: () => done("back"),
        reload: () => done("reload"),
        navigate: (url: string) => done(`navigate ${url}`),
        close: () => {},
    };
    return driver;
}

function surfaceWith(options: {
    snapshots: DomSnapshot[];
    calls?: string[];
    screen?: ScreenPoint;
    extra?: Partial<BrowserSurfaceOptions>;
}) {
    const calls = options.calls ?? [];
    const drawn: ScreenPoint[] = [];
    const selectors: PageSelector[] = [];
    const page = scriptedPage(options.snapshots, calls, options.screen);
    const surface = createBrowserSurface({
        port: 9222,
        overlay: (point) => {
            drawn.push(point);
            return true;
        },
        openPage: async (selector) => {
            selectors.push(selector);
            return page;
        },
        ...options.extra,
    });
    return { surface, calls, drawn, selectors, page };
}

function row(snapshot: SurfaceSnapshot, id: string): SurfaceCandidate {
    const found = snapshot.candidates.find((candidate) => candidate.id === id);
    if (!found) {
        throw new Error(`no row ${id}`);
    }

    return found;
}

const pages = [
    { index: 0, url: "https://mail.example.test/inbox", title: "Inbox" },
    { index: 1, url: "http://127.0.0.1:3990/", title: "Jev fixture page" },
];

test("several open pages and no selector name no page, and the refusal lists them", () => {
    expect(matchPage(pages, {})).toBeUndefined();
    expect(pageRefusal(pages, {})).toMatch(/2 CDP pages are open; pass --page-url/);
    expect(pageRefusal(pages, {})).toContain("1: http://127.0.0.1:3990/");
});

test("--page-url picks the matching page and --page-index that matches nothing names the open pages", () => {
    expect(matchPage(pages, { pageUrl: "127.0.0.1:3990" })?.index).toBe(1);
    expect(matchPage(pages, { pageIndex: 7 })).toBeUndefined();
    expect(pageRefusal(pages, { pageIndex: 7 })).toMatch(/No CDP page matches --page-index 7/);
});

test("the page is opened once, with the caller's selector, before the first read", async () => {
    const { surface, selectors, page } = surfaceWith({ snapshots: [plain], extra: { pageUrl: "3990" } });
    await surface.see();
    await surface.see();
    expect(selectors).toEqual([{ pageUrl: "3990", pageTitle: undefined, pageIndex: undefined, url: undefined }]);
    expect(page.reads).toBe(2);
});

test("only rows the page can take now are offered, and only supplied values are typed", async () => {
    const { surface } = surfaceWith({
        snapshots: [checkout],
        extra: { inputs: { email: "ada@example.com", password: "hunter-invented", name: "Ada" } },
    });
    const seen = await surface.see();
    expect(seen.candidates.map((candidate) => `${candidate.id}:${candidate.action}`)).toEqual([
        "n1:click",
        "n2f:set",
        "n3f:set",
        "n4o1:click",
        "chrome:reload:chrome",
        "chrome:scroll_down:chrome",
        "chrome:wait:chrome",
    ]);
    const serialized = SafeJSON.stringify(seen.evidence);
    expect(serialized).not.toContain("hunter-invented");
    expect(serialized).not.toContain("ada@example.com");
});

test("a text field is a candidate only when --inputs names it, and the act types exactly that value", async () => {
    const bare = await surfaceWith({ snapshots: [plain] }).surface.see();
    expect(bare.candidates.filter((candidate) => candidate.action === "set")).toHaveLength(0);

    const { surface, calls } = surfaceWith({ snapshots: [plain], extra: { inputs: { name: "Robin" } } });
    const seen = await surface.see();
    expect(await surface.act(seen, row(seen, "n3f"))).toEqual({ ok: true });
    expect(calls).toEqual(["fill n3f=Robin"]);
});

test("a page asking for a password that --inputs lacks offers nothing and touches nothing", async () => {
    const { surface, calls } = surfaceWith({ snapshots: [checkout], extra: { inputs: { email: "ada@example.com" } } });
    const seen = await surface.see();
    expect(seen.candidates).toEqual([]);
    expect(seen.evidence).toMatchObject({ passwordWall: true, fields: ["Password"] });
    expect(calls).toEqual([]);
});

test("one password key does not unlock a page that also asks for a one-time code nobody supplied", async () => {
    const twoSecrets = {
        ...checkout,
        secretFields: [
            { label: "Password", field: field("password", "password", true) },
            { label: "Verification code", field: field("otp", "text", true) },
        ],
    };
    const { surface, calls } = surfaceWith({
        snapshots: [twoSecrets],
        extra: { inputs: { email: "ada@example.com", password: "hunter-invented" } },
    });
    const seen = await surface.see();
    expect(seen.candidates).toEqual([]);
    expect(seen.evidence).toMatchObject({ passwordWall: true, fields: ["Verification code"] });
    expect(calls).toEqual([]);
});

test("a link off the page's origin is never offered, and a forged act on it is refused", async () => {
    const offsite = domAction({
        id: "n9",
        node: 9,
        kind: "click",
        role: "link",
        label: "Partner deal",
        href: "https://elsewhere.example/deal",
    });
    const local = domAction({ id: "n8", node: 8, kind: "click", role: "link", label: "Top", href: "#top" });
    const page = { ...plain, actions: [...plain.actions, offsite, local] };
    const { surface, calls } = surfaceWith({ snapshots: [page] });
    const seen = await surface.see();
    expect(seen.candidates.some((candidate) => candidate.id === "n9")).toBe(false);
    expect(seen.candidates.some((candidate) => candidate.id === "n8")).toBe(true);
    expect(calls).toEqual([]);
});

test("a password field below the fold still raises the wall, though no visible row asks for it", async () => {
    const belowFold = { ...plain, secretFields: [{ label: "Password", field: field("password", "password", true) }] };
    const { surface, calls } = surfaceWith({ snapshots: [belowFold] });
    const seen = await surface.see();
    expect(seen.candidates).toEqual([]);
    expect(seen.evidence).toMatchObject({ passwordWall: true, fields: ["Password"] });
    expect(calls).toEqual([]);
});

test("an act runs exactly the action its row was built from; a row never offered never reaches the page", async () => {
    const { surface, calls } = surfaceWith({
        snapshots: [checkout],
        extra: { inputs: { email: "ada@example.com", password: "hunter-invented" } },
    });
    const seen = await surface.see();
    expect(await surface.act(seen, row(seen, "n4o1"))).toEqual({ ok: true });
    expect(await surface.act(seen, row(seen, "chrome:scroll_down"))).toEqual({ ok: true });
    const forged = await surface.act(seen, { id: "n99", label: "invented", element: -1, action: "click" });
    expect(forged.ok).toBe(false);
    expect(calls).toEqual(["select n4o1", "scroll 1"]);
});

test("chrome rows appear only when the page can take them: back needs history, scroll needs room", async () => {
    const seen = await surfaceWith({ snapshots: [plain] }).surface.see();
    const verbs = seen.candidates
        .filter((candidate) => candidate.action === "chrome")
        .map((candidate) => candidate.chrome);
    expect(verbs).toEqual(["back", "reload", "wait"]);
});

test("a click draws the overlay at the screen point the page reported, and only then", async () => {
    const shown = surfaceWith({ snapshots: [plain], screen: { x: 125, y: 340 } });
    const seen = await shown.surface.see();
    await shown.surface.act(seen, row(seen, "n2"));
    expect(shown.drawn).toEqual([{ x: 125, y: 340 }]);

    const hidden = surfaceWith({ snapshots: [plain] });
    const background = await hidden.surface.see();
    await hidden.surface.act(background, row(background, "n2"));
    expect(hidden.drawn).toEqual([]);
});

test("the auto surface's merged snapshot and cdp: prefix reach the page row", async () => {
    const { surface, calls } = surfaceWith({ snapshots: [plain] });
    const seen = await surface.see();
    const merged: SurfaceSnapshot = {
        id: `auto:ax-token:${seen.id}`,
        label: "merged",
        candidates: seen.candidates.map((candidate) => ({ ...candidate, id: `cdp:${candidate.id}` })),
    };
    expect(await surface.act(merged, { ...row(seen, "n2") })).toEqual({ ok: true });
    expect(calls).toEqual(["click n2@g2"]);
});

/**
 * Node ids restart on every document. An act on the snapshot the loop saw must use THAT page's
 * action (and its guard, which the page checks again), never a newer page's row with the same id.
 */
test("an act uses the row of the snapshot it names, not a newer page's row with the same id", async () => {
    const next: DomSnapshot = {
        ...plain,
        url: "http://127.0.0.1:3990/second",
        actions: [domAction({ id: "n2", node: 2, kind: "click", label: "Delete everything", guard: "other" })],
        marker: "p2",
    };
    const { surface, calls } = surfaceWith({ snapshots: [plain, next] });
    const first = await surface.see();
    await surface.see();
    await surface.act(first, row(first, "n2"));
    expect(calls).toEqual(["click n2@g2"]);
});

test("a field that already holds the supplied value is no longer offered", async () => {
    const { surface } = surfaceWith({ snapshots: [checkout], extra: { inputs: { name: "Ada", password: "x" } } });
    const seen = await surface.see();
    expect(seen.candidates.some((candidate) => candidate.id === "n5f")).toBe(false);
});

test("a navigate off the page's origin is refused before it reaches the browser", async () => {
    const { surface, calls } = surfaceWith({
        snapshots: [{ ...checkout, actions: [], secretFields: [] }],
        extra: { url: "https://elsewhere.example/landing" },
    });
    const seen = await surface.see();
    const result = await surface.act(seen, row(seen, "chrome:navigate"));
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
});

test("controls below the fold reach the evidence by name, never as rows, so scrolling has a named reason", async () => {
    const seen = await surfaceWith({ snapshots: [checkout], extra: { inputs: { password: "x" } } }).surface.see();
    expect(seen.evidence).toMatchObject({ belowFold: 2, below_the_fold: ["Place order", "Terms of sale"] });
    expect(seen.candidates.some((candidate) => candidate.label === "Place order")).toBe(false);
});

const searchPage: DomSnapshot = {
    ...plain,
    url: "https://shop.example/search",
    title: "Search",
    text: "Search the catalogue",
    actions: [
        domAction({
            id: "n7f",
            node: 7,
            kind: "fill",
            role: "searchbox",
            label: "Search",
            value: "",
            field: field("q", "search"),
        }),
        domAction({ id: "n8f", node: 8, kind: "fill", label: "Email", value: "", field: field("email", "email") }),
        domAction({ id: "n9f", node: 9, kind: "fill", label: "Coupon", value: "", field: field("coupon") }),
    ],
};

test("with the writer on, a field --inputs does not cover is offered to write, never an email or credential field", async () => {
    const requests: WriterRequest[] = [];
    const writer = async (request: WriterRequest): Promise<WriterResult> => {
        requests.push(request);
        return { fill: true, text: "blue kettle" };
    };
    const { surface, calls } = surfaceWith({
        snapshots: [searchPage],
        extra: { writer, goal: "find a blue kettle", inputs: { coupon: "SAVE10" } },
    });
    const seen = await surface.see();
    const sets = seen.candidates.filter((candidate) => candidate.action === "set");
    expect(sets.map((candidate) => candidate.label)).toEqual(["Write into Search", "Coupon"]);
    expect(await surface.act(seen, row(seen, "n7f"))).toEqual({ ok: true });
    expect(calls).toEqual(["fill n7f=blue kettle"]);
    expect(requests[0]).toMatchObject({ goal: "find a blue kettle", field: { label: "Search", name: "q" } });
});

test("with the writer off nothing is offered to write, and a declined write reaches nothing (negative control)", async () => {
    const off = await surfaceWith({ snapshots: [searchPage] }).surface.see();
    expect(off.candidates.some((candidate) => candidate.label.startsWith("Write into"))).toBe(false);

    const { surface, calls } = surfaceWith({
        snapshots: [searchPage],
        extra: { writer: async () => ({ fill: false, reason: "the goal names no query" }), goal: "shop" },
    });
    const seen = await surface.see();
    const result = await surface.act(seen, row(seen, "n7f"));
    expect(result).toEqual({ ok: false, error: "writer declined: the goal names no query" });
    expect(calls).toEqual([]);
});

test("the writer asks once per identical request, never for a credential field, and refuses credential text", async () => {
    let asked = 0;
    let answer = "blue kettle";
    const writer = createWriter({
        call: async () => {
            asked += 1;
            return { object: { fill: true, text: answer, reason: "" } };
        },
    });
    const request: WriterRequest = {
        goal: "find a blue kettle",
        field: { label: "Search", role: "searchbox" },
        page: { url: "https://shop.example/", title: "Shop", text: "" },
    };
    expect(await writer(request)).toEqual({ fill: true, text: "blue kettle" });
    expect(await writer(request)).toEqual({ fill: true, text: "blue kettle" });
    expect(asked).toBe(1);

    const pin = await writer({ ...request, field: { label: "PIN code", role: "textbox" } });
    expect(pin.fill).toBe(false);
    expect(asked).toBe(1);

    answer = "my password is hunter2";
    const leaked = await writer({ ...request, goal: "something else" });
    expect(leaked).toEqual({ fill: false, reason: "the written text mentions a credential" });
});

test("the option a list already shows is not offered again, the others are", async () => {
    const shipping: DomSnapshot = {
        ...plain,
        actions: [
            domAction({
                id: "n4o0",
                node: 4,
                kind: "select",
                label: "Shipping",
                value: "Express",
                option: { index: 0, label: "Standard" },
            }),
            domAction({
                id: "n4o1",
                node: 4,
                kind: "select",
                label: "Shipping",
                value: "Express",
                option: { index: 1, label: "Express" },
            }),
        ],
    };
    const seen = await surfaceWith({ snapshots: [shipping] }).surface.see();
    const options = seen.candidates.filter((candidate) => candidate.role === "option").map((candidate) => candidate.id);
    expect(options).toEqual(["n4o0"]);
});
