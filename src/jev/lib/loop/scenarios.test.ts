import { expect, test } from "bun:test";
import { z } from "zod";
import { runGoalLoop } from "./run";
import { LOADING_STOP, type Policy, scripted, text, World, type WorldPage, type WorldRequest } from "./world";

/**
 * Scenarios of increasing difficulty, each driven through the unmodified `runGoalLoop`. Ported from
 * typesafe-computer-use `tests/test_scenarios.py`: a scenario is a page graph plus a policy that
 * reads the request the loop really sent, and it asserts the outcome the loop named and the acts
 * the world received. A scenario that exposes a loop bug stays as written and is marked failing.
 */

const GOAL = "buy a ticket to the next show";

async function drive(world: World, policy: Policy, options: { maxSteps?: number; allowYes?: boolean } = {}) {
    return runGoalLoop({
        goal: GOAL,
        surface: world.surface,
        evaluate: world.evaluator(policy),
        maxSteps: options.maxSteps ?? 12,
        allowYes: options.allowYes,
        sleep: world.sleep,
    });
}

function acted(world: World): string[] {
    return world.acts.map((act) => act.label);
}

function offered(request: WorldRequest | undefined): string[] {
    return request?.candidates.map((candidate) => candidate.label) ?? [];
}

/** The screen lines a request showed Jev, in order. */
function shown(request: WorldRequest | undefined): string[] {
    return z
        .array(z.object({ label: z.string() }))
        .parse(request?.observations ?? [])
        .map((row) => row.label);
}

/** The first offered label not already tried on this screen, the way a model that reads the hint behaves. */
const firstUntried: Policy = (request) =>
    request.candidates.find((candidate) => !request.triedHere.includes(candidate.label))?.label ?? "abstain";

const shop: WorldPage[] = [
    { name: "home", title: "Shop", rows: [text("Welcome"), "Tickets", "About"], on: { Tickets: "tickets" } },
    { name: "tickets", title: "Tickets", rows: [text("Next show: Friday"), "Buy", "Terms"], on: { Buy: "checkout" } },
    {
        name: "checkout",
        title: "Checkout",
        rows: [text("1 ticket, 40 EUR"), "Pay", "Cancel"],
        on: { Pay: "confirmation" },
    },
    { name: "confirmation", title: "Confirmation", rows: [text("Order 4821 confirmed"), "Back to shop"] },
];

test("a goal already true on the first screen verifies without acting", async () => {
    const world = new World(shop, "confirmation");

    const result = await drive(world, scripted("done"));

    expect(result).toMatchObject({ status: "verified", reason: "semantic_done", steps: 0 });
    expect(world.acts).toEqual([]);
    expect(world.requests).toHaveLength(1);
});

test("a straight three-step path is walked to done, one admitted decision per step", async () => {
    const world = new World(shop);

    const result = await drive(world, scripted("Tickets", "Buy", "Pay", "done"));

    expect(result).toMatchObject({ status: "verified", steps: 3 });
    expect(acted(world)).toEqual(["Tickets", "Buy", "Pay"]);
    expect(world.acts.map((act) => act.page)).toEqual(["home", "tickets", "checkout"]);
    expect(result.trace.map((step) => [step.status, step.dispatched, step.calls])).toEqual([
        ["act", true, 1],
        ["act", true, 1],
        ["act", true, 1],
        ["verified", undefined, 1],
    ]);
    const first = world.decisions()[0];
    expect(first).toMatchObject({ goal: GOAL, window: "Shop", triedHere: [] });
    expect(offered(first)).toEqual(["Tickets", "About"]);
    expect(shown(first)).toEqual(["Welcome", "Tickets", "About"]);
});

test("a policy that abstains, or reports the screen blocked, stops without acting", async () => {
    const abstaining = new World(shop);
    expect(await drive(abstaining, () => "abstain")).toMatchObject({
        status: "stopped",
        reason: "no_certain_act",
        steps: 0,
    });
    expect(abstaining.acts).toEqual([]);

    const blocked = new World(shop);
    expect(await drive(blocked, () => "blocked")).toMatchObject({ status: "stopped", reason: "blocked", steps: 0 });
    expect(blocked.acts).toEqual([]);
});

test("a high-risk act stops as high_risk without allowYes, and is taken with it", async () => {
    const pay = { kind: "pick" as const, label: "Pay", risk: 2 };

    const refused = new World(shop, "checkout");
    expect(await drive(refused, scripted(pay, "done"))).toMatchObject({
        status: "stopped",
        reason: "high_risk",
        steps: 0,
    });
    expect(refused.acts).toEqual([]);

    const allowed = new World(shop, "checkout");
    expect(await drive(allowed, scripted(pay, "done"), { allowYes: true })).toMatchObject({ status: "verified" });
    expect(acted(allowed)).toEqual(["Pay"]);
});

test("a failed act stops the loop with the surface's own error", async () => {
    const pages = shop.map((page) =>
        page.name === "checkout" ? { ...page, fails: { Pay: "the card was declined" } } : page
    );
    const world = new World(pages, "checkout");

    const result = await drive(world, scripted("Pay", "done"));

    expect(result).toMatchObject({ status: "stopped", reason: "the card was declined", steps: 1 });
    expect(result.trace[0]).toMatchObject({ dispatched: false, error: "the card was declined" });
    expect(acted(world)).toEqual(["Pay"]);
});

test("a loading page is waited out, and waits count toward neither the stall nor the repeat stop", async () => {
    // Four waits on one unchanged screen is past both limits (three idle acts, a third repeat), so
    // the second run only verifies if a wait is neither an act nor a repeat.
    for (const loadsIn of [2, 4]) {
        const world = new World([
            { name: "search", title: "Search", rows: ["Search", "Help"], on: { Search: "results" } },
            {
                name: "results",
                title: "Results",
                loadsIn,
                rows: [text("3 results"), "First result", "Second result"],
                on: { "First result": "detail" },
            },
            { name: "detail", title: "Detail", rows: [text("Bruno Mars, Friday"), "Buy tickets"] },
        ]);
        const policy: Policy = (request) => {
            if (request.window === "Detail") {
                return "done";
            }

            if (offered(request).includes(LOADING_STOP)) {
                return "wait";
            }

            return offered(request).includes("First result") ? "First result" : "Search";
        };

        const result = await drive(world, policy);

        expect(result).toMatchObject({ status: "verified", steps: loadsIn + 2 });
        expect(world.waits).toBe(loadsIn);
        expect(acted(world)).toEqual(["Search", "First result"]);
        expect(result.trace.filter((step) => step.status === "wait")).toHaveLength(loadsIn);
    }
});

const deadLink: WorldPage[] = [
    {
        name: "home",
        title: "Shop",
        rows: [text("Welcome"), "Old tickets", "Tickets"],
        // The old page redirects straight back home: a dead link that looks like navigation.
        on: { "Old tickets": "home", Tickets: "tickets" },
    },
    { name: "tickets", title: "Tickets", rows: [text("Next show: Friday"), "Buy"] },
];

test("a dead link back to the same page is steered away from through already_tried_on_this_screen", async () => {
    const world = new World(deadLink);
    const policy: Policy = (request) => (request.window === "Tickets" ? "done" : firstUntried(request));

    const result = await drive(world, policy);

    expect(result).toMatchObject({ status: "verified", steps: 2 });
    expect(acted(world)).toEqual(["Old tickets", "Tickets"]);
    expect(world.decisions().map((request) => request.triedHere)).toEqual([[], ["Old tickets"], []]);
});

test("a policy that ignores already_tried_on_this_screen stops as repeating on its third pick", async () => {
    const world = new World(deadLink);
    const policy: Policy = (request) => (request.window === "Tickets" ? "done" : "Old tickets");

    const result = await drive(world, policy);

    expect(result).toMatchObject({ status: "stopped", reason: "repeating", steps: 2 });
    expect(acted(world)).toEqual(["Old tickets", "Old tickets"]);
    // The loop told the model twice; the model chose the same dead link anyway.
    expect(world.decisions().map((request) => request.triedHere)).toEqual([[], ["Old tickets"], ["Old tickets"]]);
});

test("a page whose acts all do nothing stops as stalled after three acts", async () => {
    const world = new World([
        { name: "settings", title: "Settings", rows: [text("Nothing here responds"), "One", "Two", "Three", "Four"] },
    ]);

    const result = await drive(world, firstUntried);

    expect(result).toMatchObject({ status: "stopped", reason: "stalled", steps: 3 });
    expect(acted(world)).toEqual(["One", "Two", "Three"]);
});

test("a two-page cycle stops as repeating, and a policy that reads the hint breaks out of it", async () => {
    const cycle = (extra: string[]): WorldPage[] => [
        { name: "a", title: "Page A", rows: [text("Page 1"), "Next", ...extra], on: { Next: "b", Checkout: "done" } },
        { name: "b", title: "Page B", rows: [text("Page 2"), "Back"], on: { Back: "a" } },
        { name: "done", title: "Confirmation", rows: [text("Order 4821 confirmed"), "Back to shop"] },
    ];

    const naive = new World(cycle([]));
    const first: Policy = (request) => offered(request)[0] ?? "abstain";
    expect(await drive(naive, first)).toMatchObject({ status: "stopped", reason: "repeating", steps: 3 });
    expect(acted(naive)).toEqual(["Next", "Back", "Next"]);

    const reading = new World(cycle(["Checkout"]));
    const policy: Policy = (request) => (request.window === "Confirmation" ? "done" : firstUntried(request));
    expect(await drive(reading, policy)).toMatchObject({ status: "verified", steps: 3 });
    expect(acted(reading)).toEqual(["Next", "Back", "Checkout"]);
});

test("a ticking line is noise on a long page, so its dead acts stall, and progress on a short dialog", async () => {
    const board = new World([
        {
            name: "board",
            title: "Departures",
            rows: (world) => [
                text(`12:${String(world.reads).padStart(2, "0")}`),
                ...["Departures", "Gate A", "Gate B", "Gate C", "Gate D", "Gate E", "Gate F", "Gate G", "Gate H"].map(
                    text
                ),
                "Refresh",
                "Filter",
                "Sort",
                "Help",
            ],
        },
    ]);
    expect(await drive(board, firstUntried)).toMatchObject({ status: "stopped", reason: "stalled", steps: 3 });
    expect(acted(board)).toEqual(["Refresh", "Filter", "Sort"]);
    const clock = board.decisions().map((request) => shown(request)[0]);
    expect(new Set(clock).size).toBe(clock.length);

    // Five lines, one of them ticking: every read is a new screen, so nothing is ever "tried here"
    // and nothing stalls. The same policy therefore runs to the step budget.
    const dialog = new World([
        {
            name: "dialog",
            title: "Connection lost",
            rows: (world) => [text(`Retrying in ${10 - world.reads} s`), "Retry", "Cancel"],
        },
    ]);
    expect(await drive(dialog, firstUntried, { maxSteps: 5 })).toMatchObject({
        status: "stopped",
        reason: "step_budget",
        steps: 5,
    });
    expect(acted(dialog)).toEqual(["Retry", "Retry", "Retry", "Retry", "Retry"]);
});

test("more than 255 candidates go through the tournament and still reach the right target", async () => {
    const items = Array.from({ length: 300 }, (_, index) => `Item ${index}`);
    const world = new World([
        { name: "catalog", title: "Catalog", rows: [text("300 items"), ...items], on: { "Item 287": "detail" } },
        { name: "detail", title: "Item 287", rows: [text("Item 287, in stock"), "Add to cart"] },
    ]);
    const policy: Policy = (request) => (request.window === "Item 287" ? "done" : "Item 287");

    const result = await drive(world, policy);

    expect(result).toMatchObject({ status: "verified", steps: 1 });
    expect(acted(world)).toEqual(["Item 287"]);
    expect(result.trace[0]).toMatchObject({ status: "act", calls: 3 });
    // Two balanced shards, then one final round over the single finalist.
    expect(world.requests.slice(0, 3).map((request) => [request.final, request.candidates.length])).toEqual([
        [false, 150],
        [false, 150],
        [true, 1],
    ]);
    expect(world.requests.every((request) => request.candidates.length + 1 <= 255)).toBe(true);
});

// Bugs the world exposed. Each stays as the behavior the loop should have, and fails until fixed.

test("a slow app whose every act lands only after one wait is progress, not a stall", async () => {
    // Was a bug in run.ts: `idle` was compared only on the first read after an act, so a change that
    // arrived during a wait never reset it and three slow but successful acts read as dead ones.
    const step = (name: string, label: string, button: string, next: string): WorldPage => ({
        name,
        title: "Setup",
        rows: [text(label), button],
        on: { [button]: { afterWait: next } },
    });
    const world = new World([
        step("one", "Step 1 of 3", "Continue", "two"),
        step("two", "Step 2 of 3", "Next", "three"),
        step("three", "Step 3 of 3", "Finish", "finished"),
        { name: "finished", title: "Setup", rows: [text("All set"), "Close"] },
    ]);
    const policy: Policy = (request) => {
        if (offered(request).includes("Close")) {
            return "done";
        }

        const button = offered(request)[0] ?? "abstain";
        return request.triedHere.includes(button) ? "wait" : button;
    };

    const result = await drive(world, policy);

    expect(acted(world)).toEqual(["Continue", "Next", "Finish"]);
    expect(result).toMatchObject({ status: "verified" });
});

test("a confirmation page with nothing to press verifies as done", async () => {
    // Was a bug in run.ts: a screen with no candidates stopped as no_candidates before Jev was asked,
    // so a goal whose last screen is text only (a receipt, a finished progress window) never verified.
    const world = new World([
        { name: "checkout", title: "Checkout", rows: [text("1 ticket, 40 EUR"), "Pay"], on: { Pay: "receipt" } },
        { name: "receipt", title: "Receipt", rows: [text("Order 4821 confirmed"), text("A receipt was sent")] },
    ]);

    const result = await drive(world, scripted("Pay", "done"));

    expect(acted(world)).toEqual(["Pay"]);
    expect(result).toMatchObject({ status: "verified" });
});

test("a finished screen with more than 240 rows verifies as done", async () => {
    // Was a bug in observe.ts: done, blocked, wait and risk were asked only in the tournament's final
    // round, so when every shard abstained there was no final round and the fan-out stopped as
    // no_target without asking whether the goal was done.
    const world = new World([
        {
            name: "orders",
            title: "Orders",
            rows: [text("Order 4821 confirmed"), ...Array.from({ length: 300 }, (_, index) => `Order ${index}`)],
        },
    ]);

    const result = await drive(world, () => "done");

    expect(world.acts).toEqual([]);
    expect(result).toMatchObject({ status: "verified" });
});
