import { Api, collectPages } from "@app/azure-devops/api";
import type { AdoHttpMethod, AdoTransport } from "@app/azure-devops/api.types";
import type { PointOutcome } from "@app/azure-devops/lib/test-plans/types";
import type { AzureConfig, AzWorkItemRaw, JsonPatchOperation } from "@app/azure-devops/types";
import { logger } from "@genesiscz/utils/logger";

/*
 * Wire shapes of the `testplan` area (api-version 7.1). Enums travel as camelCase strings
 * (`"staticTestSuite"`, `"passed"`), not as the SDK's numbers. Only `service.ts` imports this file.
 */

export interface IdentityApi {
    displayName?: string | null;
    uniqueName?: string;
    id?: string;
}

export interface NamedRefApi {
    id: number;
    name: string;
}

export interface TestPlanApi {
    id: number;
    name: string;
    state?: string;
    areaPath?: string;
    iteration?: string;
    /** Only with `includePlanDetails=true` in a list. */
    startDate?: string;
    endDate?: string;
    description?: string;
    revision?: number;
    owner?: IdentityApi;
    updatedBy?: IdentityApi;
    updatedDate?: string;
    rootSuite: NamedRefApi;
}

/** `dynamicTestSuite` is a query-based suite. */
export type SuiteTypeApi = "staticTestSuite" | "requirementTestSuite" | "dynamicTestSuite" | "none";

export interface TestSuiteApi {
    id: number;
    name: string;
    suiteType: SuiteTypeApi;
    revision?: number;
    plan: NamedRefApi;
    parentSuite?: NamedRefApi;
    hasChildren?: boolean;
    children?: TestSuiteApi[];
    queryString?: string;
    requirementId?: number;
    lastUpdatedDate?: string;
    lastUpdatedBy?: IdentityApi;
    inheritDefaultConfigurations?: boolean;
    defaultConfigurations?: NamedRefApi[];
}

/** One row of the preview route `testplan/Count/{planId}`: the test cases directly in a suite. */
export interface SuiteCountApi {
    testPlanId: number;
    testSuiteId: number;
    count: number;
    totalCount?: number;
}

/** One suite of the old `test` area route (max api-version 5.0), the only released one with a count. */
export interface LegacySuiteApi {
    id: number;
    testCaseCount?: number;
}

export interface PointAssignmentApi {
    id: number;
    configurationId?: number;
    configurationName?: string;
    tester?: IdentityApi;
}

export interface SuiteTestCaseApi {
    order?: number;
    workItem: {
        id: number;
        name: string;
        /** An array of single-key objects: `[{ "System.State": "Design" }, ...]`. */
        workItemFields?: Record<string, unknown>[];
    };
    pointAssignments?: PointAssignmentApi[];
}

export interface TestPointApi {
    id: number;
    isActive: boolean;
    isAutomated?: boolean;
    configuration: NamedRefApi;
    tester?: IdentityApi;
    testCaseReference: { id: number; name: string; state?: string };
    testSuite?: NamedRefApi;
    testPlan?: NamedRefApi;
    lastUpdatedDate?: string;
    results: {
        outcome: string;
        state?: string;
        lastTestRunId?: number;
        lastResultId?: number;
        lastResultDetails?: { dateCompleted?: string; duration?: number; runBy?: IdentityApi };
    };
}

export interface WorkItemFieldsApi {
    id: number;
    rev: number;
    fields: Record<string, unknown>;
}

export interface ListResponse<T> {
    value?: T[];
    count?: number;
}

export interface TestPlanCreateParams {
    name: string;
    /** The iteration path; the API requires it. */
    iteration: string;
    areaPath?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
    state?: string;
    owner?: { id: string };
}

export interface TestPlanUpdateParams extends Partial<TestPlanCreateParams> {
    revision?: number;
}

export interface TestSuiteCreateParams {
    name: string;
    suiteType: SuiteTypeApi;
    parentSuite: { id: number };
    requirementId?: number;
    queryString?: string;
}

export interface TestSuiteUpdateParams {
    name?: string;
    parentSuite?: { id: number };
    queryString?: string;
    revision?: number;
}

export interface TestPointUpdate {
    id: number;
    isActive?: boolean;
    results?: { outcome: PointOutcome };
    tester?: { id: string };
}

const API_VERSION = "7.1";
/** `testplan/Count/{planId}` has no released version (`OPTIONS {org}/_apis/` lists it as 0.0). */
const COUNT_API_VERSION = "7.1-preview.1";
/** The old `test` area suites route stops at 5.0; a higher version answers 404. */
const LEGACY_SUITES_API_VERSION = "5.0";

type Query = Record<string, string | undefined>;

/** Where the per-suite test case counts came from. */
export type SuiteCountSource = "count" | "legacy";

/**
 * The `testplan` REST area (plans, suites, the test cases of a suite, test points) and the Test Case
 * work item writes. Every call goes through the transport, so a dry-run transport covers every write.
 */
export class TestPlanRest {
    constructor(
        private readonly transport: AdoTransport,
        private readonly config: AzureConfig
    ) {}

    private url(path: (string | number)[], query?: Query, apiVersion = API_VERSION): string {
        return Api.projectApiUrl(this.config, ["testplan", ...path.map(String)], query, apiVersion);
    }

    private async json<T>(method: AdoHttpMethod, url: string, description: string, body?: unknown): Promise<T> {
        const { data } = await this.transport.call<T>({ method, url, description, body });

        if (data === null) {
            throw new Error(`Azure DevOps answered ${method} ${description} with an empty body`);
        }

        return data;
    }

    private async list<T>(path: (string | number)[], query: Query, description: string): Promise<T[]> {
        return collectPages(async (continuationToken) => {
            const url = this.url(path, { ...query, continuationToken });
            const { data, continuationToken: next } = await this.transport.call<ListResponse<T>>({
                method: "GET",
                url,
                description,
            });

            return { items: data?.value ?? [], next };
        });
    }

    // ============= Plans =============

    async listPlans(options: { owner?: string; activeOnly?: boolean } = {}): Promise<TestPlanApi[]> {
        return this.list<TestPlanApi>(
            ["plans"],
            {
                includePlanDetails: "true",
                filterActivePlans: options.activeOnly ? "true" : undefined,
                owner: options.owner,
            },
            "test plans"
        );
    }

    async getPlan(planId: number): Promise<TestPlanApi> {
        return this.json<TestPlanApi>("GET", this.url(["plans", planId]), `test plan ${planId}`);
    }

    async createPlan(params: TestPlanCreateParams): Promise<TestPlanApi> {
        return this.json<TestPlanApi>("POST", this.url(["plans"]), "create test plan", params);
    }

    async updatePlan(planId: number, params: TestPlanUpdateParams): Promise<TestPlanApi> {
        return this.json<TestPlanApi>("PATCH", this.url(["plans", planId]), `update test plan ${planId}`, params);
    }

    async deletePlan(planId: number): Promise<void> {
        await this.transport.call({
            method: "DELETE",
            url: this.url(["plans", planId]),
            description: `delete test plan ${planId}`,
        });
    }

    // ============= Suites =============

    /** The root suite with its children nested, as the Define tab shows it. */
    async getSuiteTree(planId: number): Promise<TestSuiteApi[]> {
        return this.list<TestSuiteApi>(
            ["Plans", planId, "suites"],
            { asTreeView: "true" },
            `suite tree of plan ${planId}`
        );
    }

    /** Every suite of a plan as a flat list, each with its `parentSuite`. */
    async listSuites(planId: number): Promise<TestSuiteApi[]> {
        return this.list<TestSuiteApi>(["Plans", planId, "suites"], {}, `suites of plan ${planId}`);
    }

    async getSuite(planId: number, suiteId: number): Promise<TestSuiteApi> {
        return this.json<TestSuiteApi>(
            "GET",
            this.url(["Plans", planId, "suites", suiteId], { expand: "children" }),
            `suite ${suiteId} of plan ${planId}`
        );
    }

    /**
     * Test cases directly in each suite of a plan. The released 7.1 suite objects carry no count, so
     * this asks the preview `Count` route (what the web UI shows), then the old `test` area route at
     * 5.0. Null when neither answers; a suite with no test cases is missing from the map.
     */
    async suiteCounts(planId: number): Promise<{ counts: Map<number, number>; source: SuiteCountSource } | null> {
        try {
            const url = this.url(["Count", planId], {}, COUNT_API_VERSION);
            const rows = await this.json<ListResponse<SuiteCountApi>>("GET", url, `suite counts of plan ${planId}`);
            return { counts: new Map((rows.value ?? []).map((row) => [row.testSuiteId, row.count])), source: "count" };
        } catch (error) {
            logger.debug({ error, planId }, "[test-plans] Count route failed; trying the 5.0 suites route");
        }

        try {
            const url = Api.projectApiUrl(
                this.config,
                ["test", "Plans", String(planId), "suites"],
                {},
                LEGACY_SUITES_API_VERSION
            );
            const rows = await this.json<ListResponse<LegacySuiteApi>>("GET", url, `legacy suites of plan ${planId}`);
            const counts = new Map<number, number>();

            for (const row of rows.value ?? []) {
                if (row.testCaseCount) {
                    counts.set(row.id, row.testCaseCount);
                }
            }

            return { counts, source: "legacy" };
        } catch (error) {
            logger.warn({ error, planId }, "[test-plans] no route gave suite counts; the tree shows none");
            return null;
        }
    }

    async createSuite(planId: number, params: TestSuiteCreateParams): Promise<TestSuiteApi> {
        return this.json<TestSuiteApi>(
            "POST",
            this.url(["Plans", planId, "suites"]),
            `create suite in plan ${planId}`,
            params
        );
    }

    async updateSuite(planId: number, suiteId: number, params: TestSuiteUpdateParams): Promise<TestSuiteApi> {
        return this.json<TestSuiteApi>(
            "PATCH",
            this.url(["Plans", planId, "suites", suiteId]),
            `update suite ${suiteId} of plan ${planId}`,
            params
        );
    }

    async deleteSuite(planId: number, suiteId: number): Promise<void> {
        await this.transport.call({
            method: "DELETE",
            url: this.url(["Plans", planId, "suites", suiteId]),
            description: `delete suite ${suiteId} of plan ${planId}`,
        });
    }

    /** Every suite, in any plan of the organization, that holds the test case. */
    async suitesOfTestCase(testCaseId: number): Promise<TestSuiteApi[]> {
        const url = Api.orgUrl(this.config, ["testplan", "suites"], { testCaseId: String(testCaseId) });
        const { data } = await this.transport.call<ListResponse<TestSuiteApi>>({
            method: "GET",
            url,
            description: `suites of test case ${testCaseId}`,
        });

        return data?.value ?? [];
    }

    // ============= Test cases of a suite =============

    async listSuiteTestCases(
        planId: number,
        suiteId: number,
        witFields: readonly string[]
    ): Promise<SuiteTestCaseApi[]> {
        return this.list<SuiteTestCaseApi>(
            ["Plans", planId, "Suites", suiteId, "TestCase"],
            { witFields: witFields.length > 0 ? witFields.join(",") : undefined },
            `test cases of suite ${suiteId}`
        );
    }

    async addTestCases(planId: number, suiteId: number, testCaseIds: readonly number[]): Promise<SuiteTestCaseApi[]> {
        const body = testCaseIds.map((id) => ({ workItem: { id } }));
        const added = await this.json<ListResponse<SuiteTestCaseApi> | SuiteTestCaseApi[]>(
            "POST",
            this.url(["Plans", planId, "Suites", suiteId, "TestCase"]),
            `add ${testCaseIds.length} test case(s) to suite ${suiteId}`,
            body
        );

        return Array.isArray(added) ? added : (added.value ?? []);
    }

    /** Removes the test cases from the suite only; the Test Case work items stay. */
    async removeTestCases(planId: number, suiteId: number, testCaseIds: readonly number[]): Promise<void> {
        await this.transport.call({
            method: "DELETE",
            url: this.url(["Plans", planId, "Suites", suiteId, "TestCase"], { testIds: testCaseIds.join(",") }),
            description: `remove ${testCaseIds.length} test case(s) from suite ${suiteId}`,
        });
    }

    // ============= Test Case work items =============

    /** Fields of up to 200 work items per call, by GET so a read never looks like a write. */
    async getWorkItems(ids: readonly number[], fields: readonly string[]): Promise<WorkItemFieldsApi[]> {
        const items: WorkItemFieldsApi[] = [];

        for (let start = 0; start < ids.length; start += 200) {
            const chunk = ids.slice(start, start + 200);
            const url = Api.witUrl(this.config, "workitems", {
                ids: chunk.join(","),
                fields: fields.join(","),
                errorPolicy: "omit",
            });
            const { data } = await this.transport.call<ListResponse<WorkItemFieldsApi | null>>({
                method: "GET",
                url,
                description: `${chunk.length} work item(s)`,
            });

            for (const item of data?.value ?? []) {
                if (item) {
                    items.push(item);
                }
            }
        }

        return items;
    }

    /** Ids a WIQL query returns; a POST, but it reads. */
    async queryIds(wiql: string, top: number): Promise<number[]> {
        const { data } = await this.transport.call<{ workItems?: { id: number }[] }>({
            method: "POST",
            url: Api.witUrl(this.config, "wiql", { $top: String(top) }),
            body: { query: wiql },
            description: "WIQL",
        });

        return (data?.workItems ?? []).map((item) => item.id);
    }

    /** Creates a Test Case work item from JSON Patch operations on its fields. */
    async createTestCase(operations: readonly JsonPatchOperation[]): Promise<AzWorkItemRaw> {
        const { data } = await this.transport.call<AzWorkItemRaw>({
            method: "POST",
            url: Api.witUrl(this.config, ["workitems", `$${encodeURIComponent("Test Case")}`]),
            body: operations,
            contentType: "application/json-patch+json",
            description: "create test case",
        });

        if (!data) {
            throw new Error("Azure DevOps answered the test case create with an empty body");
        }

        return data;
    }

    async updateTestCase(id: number, operations: readonly JsonPatchOperation[]): Promise<AzWorkItemRaw> {
        const { data } = await this.transport.call<AzWorkItemRaw>({
            method: "PATCH",
            url: Api.witUrl(this.config, ["workitems", String(id)]),
            body: operations,
            contentType: "application/json-patch+json",
            description: `update test case ${id}`,
        });

        if (!data) {
            throw new Error(`Azure DevOps answered the update of test case ${id} with an empty body`);
        }

        return data;
    }

    /** Deletes the Test Case work item for good, with its points and results. */
    async deleteTestCase(testCaseId: number): Promise<void> {
        await this.transport.call({
            method: "DELETE",
            url: this.url(["testcases", testCaseId]),
            description: `delete test case ${testCaseId}`,
        });
    }

    // ============= Test points (the Execute tab) =============

    async listPoints(planId: number, suiteId: number, options: { testCaseId?: number } = {}): Promise<TestPointApi[]> {
        return this.list<TestPointApi>(
            ["Plans", planId, "Suites", suiteId, "TestPoint"],
            {
                includePointDetails: "true",
                returnIdentityRef: "true",
                testCaseId: options.testCaseId === undefined ? undefined : String(options.testCaseId),
            },
            `test points of suite ${suiteId}`
        );
    }

    async updatePoints(planId: number, suiteId: number, updates: readonly TestPointUpdate[]): Promise<TestPointApi[]> {
        const result = await this.json<ListResponse<TestPointApi> | TestPointApi[]>(
            "PATCH",
            this.url(["Plans", planId, "Suites", suiteId, "TestPoint"], {
                includePointDetails: "true",
                returnIdentityRef: "true",
            }),
            `update ${updates.length} test point(s) of suite ${suiteId}`,
            updates
        );

        return Array.isArray(result) ? result : (result.value ?? []);
    }
}
