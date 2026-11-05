import { describe, expect, test } from "bun:test";
import type { AdoRequest, AdoResponse, AdoTransport } from "@app/azure-devops/api.types";
import { show } from "@app/azure-devops/commands/test-plan";
import { parseIdList, parsePlanRef, parseSuiteRef } from "@app/azure-devops/lib/test-plans/refs";
import { renderSuiteTree } from "@app/azure-devops/lib/test-plans/render";
import { TestPlans } from "@app/azure-devops/lib/test-plans/service";
import type { AzureConfig } from "@app/azure-devops/types";

const CONFIG: AzureConfig = {
    org: "https://dev.azure.com/acme",
    project: "Shop",
    projectId: "00000000-0000-0000-0000-000000000001",
    apiResource: "499b84ac-1321-427f-aa17-267ca6975798",
};

type Handler = (request: AdoRequest) => unknown;

/** Answers by `METHOD path-fragment`; an unmatched call fails the test. Every call is recorded. */
class FakeTransport implements AdoTransport {
    readonly calls: AdoRequest[] = [];

    constructor(private readonly routes: [string, Handler][]) {}

    async call<T>(request: AdoRequest): Promise<AdoResponse<T>> {
        this.calls.push(request);
        const path = new URL(request.url).pathname + new URL(request.url).search;
        const route = this.routes.find(([key]) => {
            const [method, fragment] = key.split(" ");
            return method === request.method && path.includes(fragment);
        });

        if (!route) {
            throw new Error(`unexpected ${request.method} ${path}`);
        }

        return { data: route[1](request) as T };
    }

    writes(): AdoRequest[] {
        return this.calls.filter((call) => call.method !== "GET" && !call.url.includes("/wiql"));
    }
}

const PLAN = {
    id: 10,
    name: "Checkout",
    state: "Active",
    revision: 3,
    owner: { displayName: "Alice Example", uniqueName: "alice@example.com", id: "a1" },
    rootSuite: { id: 11, name: "Checkout" },
};

const TREE = {
    value: [
        {
            id: 11,
            name: "Checkout",
            suiteType: "staticTestSuite",
            plan: { id: 10, name: "Checkout" },
            children: [
                {
                    id: 12,
                    name: "Cart",
                    suiteType: "staticTestSuite",
                    plan: { id: 10, name: "Checkout" },
                    parentSuite: { id: 11, name: "Checkout" },
                    children: [
                        {
                            id: 13,
                            name: "Coupons",
                            suiteType: "requirementTestSuite",
                            requirementId: 77,
                            plan: { id: 10, name: "Checkout" },
                            parentSuite: { id: 12, name: "Cart" },
                        },
                    ],
                },
            ],
        },
    ],
};

function planRoutes(counts: Handler): [string, Handler][] {
    return [
        ["GET /testplan/plans/10", () => PLAN],
        ["GET asTreeView=true", () => TREE],
        ["GET /testplan/Count/10", counts],
        [
            "GET /test/Plans/10/suites",
            () => ({
                value: [
                    { id: 12, testCaseCount: 2 },
                    { id: 13, testCaseCount: 5 },
                ],
            }),
        ],
    ];
}

describe("refs", () => {
    test("show writes snapshots only when requested, including JSON output", async () => {
        const writes: string[] = [];
        const save = async (name: string, markdown: string) => {
            writes.push(`${name}:${markdown}`);
            return "snapshot";
        };
        await show({ format: "md" }, [], { id: 1 }, () => "rendered", "plan-1", save);
        await show({ format: "json" }, [], { id: 1 }, () => "rendered", "plan-1", save);
        expect(writes).toEqual([]);
        await show({ format: "md", save: true }, [], { id: 1 }, () => "rendered", "plan-1", save);
        await show({ format: "json", save: true }, [], { id: 1 }, () => "rendered", "plan-1", save);
        expect(writes).toEqual(["plan-1:rendered", "plan-1:rendered"]);
    });
    test("reads a plan and suite from a pasted URL, and refuses another organization", () => {
        const url = "https://dev.azure.com/acme/Shop/_testPlans/execute?planId=10&suiteId=13";
        expect(parsePlanRef(url, CONFIG.org)).toEqual({ planId: 10, suiteId: 13 });
        expect(parseSuiteRef("10", "13")).toEqual({ planId: 10, suiteId: 13 });
        expect(() => parsePlanRef(url.replace("acme", "other"), CONFIG.org)).toThrow("organization 'other'");
        expect(() => parseSuiteRef("10", undefined)).toThrow("Name the suite");
        expect(parseIdList(["1,2", "2 3"], "test case")).toEqual([1, 2, 3]);
    });
});

describe("planDetails", () => {
    test("nests the suites and takes the counts from the Count route", async () => {
        const transport = new FakeTransport(
            planRoutes(() => ({
                value: [
                    { testPlanId: 10, testSuiteId: 12, count: 4 },
                    { testPlanId: 10, testSuiteId: 13, count: 1 },
                ],
            }))
        );
        const plan = await new TestPlans(transport, CONFIG).planDetails({ planId: 10 });

        expect(plan.countSource).toBe("count");
        expect(plan.owner).toBe("Alice Example");
        expect(renderSuiteTree(plan.suites)).toBe(
            ["- Checkout `#11`", "  - Cart (4) `#12`", "    - Coupons (1) [requirement #77] `#13`"].join("\n")
        );
        expect(transport.calls.some((call) => call.url.includes("/test/Plans/"))).toBe(false);
    });

    test("falls back to the 5.0 route when the Count route fails, and has no counts when both fail", async () => {
        const failing = (): never => {
            throw new Error("API Error 404");
        };
        const legacy = await new TestPlans(new FakeTransport(planRoutes(failing)), CONFIG).planDetails({ planId: 10 });
        expect(legacy.countSource).toBe("legacy");
        expect(legacy.suites.children[0].testCaseCount).toBe(2);

        const routes = planRoutes(failing).filter(([key]) => !key.includes("/test/Plans/"));
        routes.push(["GET /test/Plans/10/suites", failing]);
        const none = await new TestPlans(new FakeTransport(routes), CONFIG).planDetails({ planId: 10 });
        expect(none.countSource).toBe("none");
        expect(none.suites.children[0].testCaseCount).toBeUndefined();
    });
});

describe("listPlans", () => {
    test("filters by name, id and owner on the client", async () => {
        const transport = new FakeTransport([
            [
                "GET /testplan/plans?",
                () => ({
                    value: [
                        PLAN,
                        {
                            ...PLAN,
                            id: 20,
                            name: "Search",
                            owner: { displayName: "Bob", uniqueName: "bob@example.com" },
                        },
                    ],
                }),
            ],
        ]);
        const plans = new TestPlans(transport, CONFIG);

        expect((await plans.listPlans({ owner: "BOB@" })).map((plan) => plan.id)).toEqual([20]);
        expect((await plans.listPlans({ name: "check" })).map((plan) => plan.id)).toEqual([10]);
        expect((await plans.listPlans({ name: "20" })).map((plan) => plan.id)).toEqual([20]);
        expect(transport.calls[0].url).toContain("includePlanDetails=true");
    });
});

describe("writes", () => {
    test("case updates test the work item type before modifying it", async () => {
        const transport = new FakeTransport([
            [
                "PATCH /wit/workitems/42",
                (request) => {
                    expect(request.body).toContainEqual({
                        op: "test",
                        path: "/fields/System.WorkItemType",
                        value: "Test Case",
                    });
                    throw new Error("type test failed for Bug");
                },
            ],
        ]);
        await expect(new TestPlans(transport, CONFIG).updateTestCase(42, { title: "New" }, true)).rejects.toThrow(
            "type test failed"
        );
    });
    test("a dry run sends no write, and names what it would send", async () => {
        const transport = new FakeTransport([["GET /testplan/plans/10", () => PLAN]]);
        const plans = new TestPlans(transport, CONFIG);

        const outcomes = [
            await plans.createPlan({ name: "New" }, false),
            await plans.createSuite({ planId: 10, name: "Wallet" }, false),
            await plans.updateSuite({ planId: 10, suiteId: 12 }, { parentId: 13 }, false),
            await plans.deleteSuite({ planId: 10, suiteId: 12 }, false),
            await plans.addTestCases({ planId: 10, suiteId: 12 }, [5], false),
            await plans.createTestCase({ title: "Pay", steps: [{ action: "Pay", expected: "Paid" }] }, false),
            await plans.deleteTestCase(5, false),
        ];

        expect(outcomes.every((outcome) => outcome.dryRun)).toBe(true);
        expect(transport.writes()).toEqual([]);
        const suite = outcomes[1];
        expect(suite.dryRun && suite.requests[0].body).toMatchObject({
            suiteType: "staticTestSuite",
            parentSuite: { id: 11 },
        });
        const plan = outcomes[0];
        expect(plan.dryRun && plan.requests[0].body).toMatchObject({ iteration: "Shop", areaPath: "Shop" });
    });

    test("moving a suite sends the new parent with the current revision", async () => {
        const transport = new FakeTransport([
            ["GET /testplan/Plans/10/suites/12", () => ({ ...TREE.value[0].children[0], revision: 6 })],
            [
                "PATCH /testplan/Plans/10/suites/12",
                (request) => ({ ...TREE.value[0].children[0], parentSuite: { id: 13, name: "x" }, body: request.body }),
            ],
        ]);
        const outcome = await new TestPlans(transport, CONFIG).updateSuite(
            { planId: 10, suiteId: 12 },
            { parentId: 13 },
            true
        );

        expect(outcome).toEqual({ dryRun: false, result: { planId: 10, suiteId: 12, name: "Cart", parentId: 13 } });
        expect(transport.writes().map((call) => call.body)).toEqual([
            { name: undefined, parentSuite: { id: 13 }, queryString: undefined, revision: 6 },
        ]);
    });

    test("a created test case gets its steps XML and is added to the named suite", async () => {
        const transport = new FakeTransport([
            ["POST /wit/workitems/$Test%20Case", () => ({ id: 500, rev: 1, fields: {} })],
            ["POST /testplan/Plans/10/Suites/12/TestCase", () => ({ value: [{ workItem: { id: 500, name: "Pay" } }] })],
        ]);
        const outcome = await new TestPlans(transport, CONFIG).createTestCase(
            {
                title: "Pay",
                steps: [{ action: "Pay", expected: "Paid" }],
                priority: 2,
                suite: { planId: 10, suiteId: 12 },
            },
            true
        );

        expect(outcome.dryRun).toBe(false);
        const [create, add] = transport.writes();
        expect(create.contentType).toBe("application/json-patch+json");
        expect(create.body).toEqual([
            { op: "add", path: "/fields/System.Title", value: "Pay" },
            {
                op: "add",
                path: "/fields/Microsoft.VSTS.TCM.Steps",
                value:
                    '<steps id="0" last="2"><step id="2" type="ValidateStep"><parameterizedString isformatted="true">&lt;p&gt;Pay&lt;/p&gt;</parameterizedString>' +
                    '<parameterizedString isformatted="true">&lt;p&gt;Paid&lt;/p&gt;</parameterizedString><description/></step></steps>',
            },
            { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 2 },
        ]);
        expect(add.body).toEqual([{ workItem: { id: 500 } }]);
    });

    test("an add that adds nothing is an error", async () => {
        const transport = new FakeTransport([["POST /testplan/Plans/10/Suites/12/TestCase", () => ({ value: [] })]]);
        await expect(
            new TestPlans(transport, CONFIG).addTestCases({ planId: 10, suiteId: 12 }, [9], true)
        ).rejects.toThrow("added none");
    });

    test("case creation reports the created ID when suite attachment fails", async () => {
        for (const response of [
            () => ({ value: [] }),
            () => {
                throw new Error("offline");
            },
        ]) {
            const transport = new FakeTransport([
                ["POST /wit/workitems/$Test%20Case", () => ({ id: 500, rev: 1, fields: {} })],
                ["POST /testplan/Plans/10/Suites/12/TestCase", response],
            ]);
            await expect(
                new TestPlans(transport, CONFIG).createTestCase(
                    { title: "Pay", suite: { planId: 10, suiteId: 12 } },
                    true
                )
            ).rejects.toThrow("suite add 10 12 --cases 500 --confirm");
        }
    });

    test("an outcome by test case id sets every point of that test case", async () => {
        const point = (id: number, testCaseId: number) => ({
            id,
            isActive: true,
            configuration: { id: 1, name: "Chrome" },
            testCaseReference: { id: testCaseId, name: `Case ${testCaseId}` },
            results: { outcome: "passed", state: "completed" },
        });
        const transport = new FakeTransport([
            [
                "GET /testplan/Plans/10/Suites/12/TestPoint",
                () => ({ value: [point(1, 500), point(2, 500), point(3, 600)] }),
            ],
            ["PATCH /testplan/Plans/10/Suites/12/TestPoint", () => ({ value: [point(1, 500), point(2, 500)] })],
        ]);
        const outcome = await new TestPlans(transport, CONFIG).setOutcome(
            { planId: 10, suiteId: 12, testCaseIds: [500], outcome: "passed" },
            true
        );

        expect(transport.writes()[0].body).toEqual([
            { id: 1, results: { outcome: "passed" } },
            { id: 2, results: { outcome: "passed" } },
        ]);
        expect(outcome.dryRun === false && outcome.result.map((row) => row.outcome)).toEqual(["passed", "passed"]);
    });
});

describe("search", () => {
    test("a suite read failure does not discard other plans", async () => {
        const transport = new FakeTransport([
            ["GET /testplan/plans?", () => ({ value: [PLAN, { ...PLAN, id: 20 }] })],
            [
                "GET /testplan/Plans/10/suites",
                () => {
                    throw new Error("offline");
                },
            ],
            ["GET /testplan/Plans/20/suites", () => ({ value: [{ id: 21, name: "Cart", plan: { id: 20 } }] })],
        ]);
        const hits = await new TestPlans(transport, CONFIG).search("cart", { kinds: ["suite"] });
        expect(hits.map((hit) => hit.id)).toEqual([21]);
    });
    test("the limit applies separately to suite and case hits", async () => {
        const transport = new FakeTransport([
            ["GET /testplan/plans/10", () => PLAN],
            [
                "GET /testplan/Plans/10/suites",
                () => ({
                    value: [
                        { id: 12, name: "Cart one", plan: PLAN },
                        { id: 13, name: "Cart two", plan: PLAN },
                    ],
                }),
            ],
            ["POST /wit/wiql", () => ({ workItems: [{ id: 20 }] })],
            ["GET /wit/workitems?", () => ({ value: [{ id: 20, fields: { "System.Title": "Cart case" } }] })],
        ]);
        const hits = await new TestPlans(transport, CONFIG).search("cart", {
            kinds: ["suite", "case"],
            planId: 10,
            top: 1,
        });
        expect(hits.map((hit) => [hit.kind, hit.id])).toEqual([
            ["suite", 12],
            ["case", 20],
        ]);
    });
    test("finds suites by name with their path below the root, and skips the root suite", async () => {
        const transport = new FakeTransport([
            ["GET /testplan/plans/10", () => PLAN],
            [
                "GET /testplan/Plans/10/suites",
                () => ({
                    value: [
                        { id: 11, name: "Checkout", suiteType: "staticTestSuite", plan: PLAN },
                        {
                            id: 12,
                            name: "Cart",
                            suiteType: "staticTestSuite",
                            plan: PLAN,
                            parentSuite: { id: 11, name: "Checkout" },
                        },
                        {
                            id: 13,
                            name: "Cart coupons",
                            suiteType: "staticTestSuite",
                            plan: PLAN,
                            parentSuite: { id: 12, name: "Cart" },
                        },
                    ],
                }),
            ],
        ]);
        const hits = await new TestPlans(transport, CONFIG).search("cart", { kinds: ["suite"], planId: 10 });

        expect(hits.map((hit) => [hit.id, hit.path])).toEqual([
            [12, ["Cart"]],
            [13, ["Cart", "Cart coupons"]],
        ]);
    });
});
