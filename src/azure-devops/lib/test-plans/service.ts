import { Api } from "@app/azure-devops/api";
import type { AdoTransport } from "@app/azure-devops/api.types";
import { type PlanRef, type SuiteRef, testPlansWebUrl } from "@app/azure-devops/lib/test-plans/refs";
import {
    type IdentityApi,
    type SuiteTypeApi,
    type TestPlanApi,
    TestPlanRest,
    type TestPlanUpdateParams,
    type TestPointApi,
    type TestSuiteApi,
    type WorkItemFieldsApi,
} from "@app/azure-devops/lib/test-plans/rest";
import {
    buildStepsXml,
    markdownToStepHtml,
    parseStepsXml,
    parseTestCaseParameters,
    type TestStep,
    type TestStepInput,
} from "@app/azure-devops/lib/test-plans/steps";
import type {
    PointOutcome,
    SuiteKind,
    SuiteNode,
    SuiteTestCaseRow,
    TestCaseDetails,
    TestCaseSuiteRef,
    TestPlanDetails,
    TestPlanSummary,
    TestPointRow,
    TestSuiteDetails,
} from "@app/azure-devops/lib/test-plans/types";
import type { AzureConfig, JsonPatchOperation } from "@app/azure-devops/types";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { htmlToMarkdown } from "@genesiscz/utils/markdown/html-to-md";

const F = {
    title: "System.Title",
    state: "System.State",
    rev: "System.Rev",
    area: "System.AreaPath",
    iteration: "System.IterationPath",
    assignedTo: "System.AssignedTo",
    description: "System.Description",
    type: "System.WorkItemType",
    priority: "Microsoft.VSTS.Common.Priority",
    automation: "Microsoft.VSTS.TCM.AutomationStatus",
    steps: "Microsoft.VSTS.TCM.Steps",
    parameters: "Microsoft.VSTS.TCM.Parameters",
    dataSource: "Microsoft.VSTS.TCM.LocalDataSource",
} as const;

const TEST_CASE_FIELDS = Object.values(F);
const SUITE_CASE_FIELDS = [F.title, F.state, F.priority, F.assignedTo];

const SUITE_KIND: Record<SuiteTypeApi, SuiteKind> = {
    staticTestSuite: "static",
    requirementTestSuite: "requirement",
    dynamicTestSuite: "query",
    none: "static",
};

const SUITE_TYPE: Record<SuiteKind, SuiteTypeApi> = {
    static: "staticTestSuite",
    requirement: "requirementTestSuite",
    query: "dynamicTestSuite",
};

/** A write the command prints instead of sending, until `--confirm`. */
export interface PlannedRequest {
    method: "POST" | "PATCH" | "DELETE";
    what: string;
    body?: unknown;
}

export type WriteOutcome<T> = { dryRun: true; requests: PlannedRequest[] } | { dryRun: false; result: T };

export interface PlanFilter {
    /** Part of the name or the id. */
    name?: string;
    /** Part of the owner's display name, e-mail or id. */
    owner?: string;
    activeOnly?: boolean;
}

export type SearchKind = "plan" | "suite" | "case";

export interface SearchHit {
    kind: SearchKind;
    id: number;
    name: string;
    planId?: number;
    planName?: string;
    /** Suite names from below the root suite down to the hit. */
    path?: string[];
    state?: string;
    url: string;
}

export interface PlanInput {
    name?: string;
    iteration?: string;
    areaPath?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
    state?: "Active" | "Inactive";
}

export interface TestCaseInput {
    title?: string;
    steps?: TestStepInput[];
    priority?: number;
    state?: string;
    areaPath?: string;
    iterationPath?: string;
    assignedTo?: string;
    /** Markdown, stored as HTML. */
    description?: string;
    /** Any other field by reference name. */
    fields?: { name: string; value: string }[];
}

function identityName(identity: IdentityApi | undefined | null): string | undefined {
    return identity?.displayName ?? identity?.uniqueName ?? undefined;
}

function contains(haystack: string | undefined, needle: string): boolean {
    return (haystack ?? "").toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function fieldString(fields: Record<string, unknown>, name: string): string | undefined {
    const value = fields[name];

    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    if (typeof value === "object" && "displayName" in value && typeof value.displayName === "string") {
        return value.displayName;
    }

    return String(value);
}

function fieldNumber(fields: Record<string, unknown>, name: string): number | undefined {
    const value = fields[name];
    return typeof value === "number" ? value : undefined;
}

/** The test case list gives fields as `[{ "System.State": "Design" }, ...]`. */
function flattenFields(entries: readonly Record<string, unknown>[] | undefined): Record<string, unknown> {
    return Object.assign({}, ...(entries ?? []));
}

/** `System.AssignedTo` in a list is `Name <mail>`; the name part reads better. */
function personName(value: string | undefined): string | undefined {
    return value?.replace(/\s*<[^>]+>\s*$/, "") || undefined;
}

function escapeWiql(text: string): string {
    return text.replace(/'/g, "''");
}

/**
 * Azure DevOps Test Plans: plans, suites, test cases and test points, in the shapes the CLI prints.
 * The REST calls, the wire shapes, the count sources and the Steps XML stay inside.
 */
export class TestPlans {
    private readonly rest: TestPlanRest;

    constructor(
        transport: AdoTransport,
        private readonly config: AzureConfig
    ) {
        this.rest = new TestPlanRest(transport, config);
    }

    // ============= Reads =============

    async listPlans(filter: PlanFilter = {}): Promise<TestPlanSummary[]> {
        const plans = await this.rest.listPlans({ activeOnly: filter.activeOnly });
        const name = filter.name?.trim();
        const owner = filter.owner?.trim();

        return plans
            .filter((plan) => !name || contains(plan.name, name) || String(plan.id) === name)
            .filter(
                (plan) =>
                    !owner ||
                    contains(plan.owner?.displayName ?? undefined, owner) ||
                    contains(plan.owner?.uniqueName, owner) ||
                    plan.owner?.id === owner
            )
            .map((plan) => this.summary(plan))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async planDetails(ref: PlanRef): Promise<TestPlanDetails> {
        const [plan, tree, counts] = await Promise.all([
            this.rest.getPlan(ref.planId),
            this.rest.getSuiteTree(ref.planId),
            this.rest.suiteCounts(ref.planId),
        ]);
        const root = tree.find((suite) => suite.id === plan.rootSuite.id) ?? tree[0];

        if (!root) {
            throw new Error(`Test plan ${ref.planId} has no root suite`);
        }

        return {
            ...this.summary(plan),
            description: plan.description ? htmlToMarkdown(plan.description) : undefined,
            revision: plan.revision,
            updatedBy: identityName(plan.updatedBy),
            updatedDate: plan.updatedDate,
            suites: this.suiteNode(root, counts?.counts),
            countSource: counts?.source ?? "none",
        };
    }

    async suiteDetails(ref: SuiteRef): Promise<TestSuiteDetails> {
        const [suite, cases] = await Promise.all([
            this.rest.getSuite(ref.planId, ref.suiteId),
            this.rest.listSuiteTestCases(ref.planId, ref.suiteId, SUITE_CASE_FIELDS),
        ]);

        const testCases: SuiteTestCaseRow[] = cases.map((item) => {
            const fields = flattenFields(item.workItem.workItemFields);
            return {
                id: item.workItem.id,
                title: item.workItem.name,
                state: fieldString(fields, F.state),
                priority: fieldNumber(fields, F.priority),
                assignedTo: personName(fieldString(fields, F.assignedTo)),
                points: (item.pointAssignments ?? []).map((point) => ({
                    id: point.id,
                    configuration: point.configurationName,
                    tester: identityName(point.tester),
                })),
            };
        });

        return {
            plan: { id: suite.plan.id, name: suite.plan.name },
            id: suite.id,
            name: suite.name,
            kind: SUITE_KIND[suite.suiteType] ?? "static",
            parent: suite.parentSuite ? { id: suite.parentSuite.id, name: suite.parentSuite.name } : undefined,
            requirementId: suite.requirementId,
            query: suite.queryString,
            revision: suite.revision,
            lastUpdatedDate: suite.lastUpdatedDate,
            lastUpdatedBy: identityName(suite.lastUpdatedBy),
            children: (suite.children ?? []).map((child) => ({
                id: child.id,
                name: child.name,
                kind: SUITE_KIND[child.suiteType] ?? "static",
            })),
            testCases,
            url: testPlansWebUrl(this.config, ref),
        };
    }

    /** The Execute tab of a suite: one row per test case and configuration. */
    async points(ref: SuiteRef, options: { testCaseId?: number } = {}): Promise<TestPointRow[]> {
        const points = await this.rest.listPoints(ref.planId, ref.suiteId, options);
        return points.map((point) => this.pointRow(point));
    }

    async testCase(id: number): Promise<TestCaseDetails> {
        const [item] = await this.rest.getWorkItems([id], TEST_CASE_FIELDS);

        if (!item) {
            throw new Error(`Work item ${id} was not found`);
        }

        const type = fieldString(item.fields, F.type);

        if (type && type !== "Test Case") {
            throw new Error(`Work item ${id} is a ${type}, not a Test Case`);
        }

        const [steps, suites] = await Promise.all([
            this.expandSharedSteps(parseStepsXml(fieldString(item.fields, F.steps))),
            this.suitesOf(id),
        ]);
        const description = fieldString(item.fields, F.description);

        return {
            id: item.id,
            rev: item.rev,
            title: fieldString(item.fields, F.title) ?? "",
            state: fieldString(item.fields, F.state),
            priority: fieldNumber(item.fields, F.priority),
            assignedTo: fieldString(item.fields, F.assignedTo),
            areaPath: fieldString(item.fields, F.area),
            iterationPath: fieldString(item.fields, F.iteration),
            automationStatus: fieldString(item.fields, F.automation),
            description: description ? htmlToMarkdown(description) : undefined,
            steps,
            parameters: parseTestCaseParameters(
                fieldString(item.fields, F.parameters),
                fieldString(item.fields, F.dataSource)
            ),
            suites,
            url: Api.workItemWebUrl(this.config, item.id),
        };
    }

    /**
     * Plans, suites and test cases whose name holds the text, or whose id is the text. Suites are read
     * plan by plan (one call each), so `planId` narrows a suite search; test cases come from one WIQL query.
     */
    async search(
        text: string,
        options: { kinds?: SearchKind[]; planId?: number; top?: number } = {}
    ): Promise<SearchHit[]> {
        const needle = text.trim();

        if (!needle) {
            throw new Error("Search text is empty");
        }

        const kinds = new Set<SearchKind>(options.kinds?.length ? options.kinds : ["plan", "suite", "case"]);
        const top = options.top ?? 50;
        const byId = /^\d+$/.test(needle) ? Number(needle) : undefined;
        const hits: SearchHit[] = [];
        const plans =
            kinds.has("plan") || kinds.has("suite")
                ? options.planId !== undefined
                    ? [await this.rest.getPlan(options.planId)]
                    : await this.rest.listPlans()
                : [];

        if (kinds.has("plan")) {
            for (const plan of plans) {
                if (plan.id === byId || contains(plan.name, needle)) {
                    hits.push({
                        kind: "plan",
                        id: plan.id,
                        name: plan.name,
                        state: plan.state,
                        url: this.planUrl(plan.id),
                    });
                }
            }
        }

        if (kinds.has("suite")) {
            const perPlan = await concurrentMap({
                items: plans,
                concurrency: 4,
                fn: (plan) => this.rest.listSuites(plan.id),
            });

            for (const [plan, suites] of perPlan) {
                const byIdMap = new Map<number, TestSuiteApi>(suites.map((suite) => [suite.id, suite]));

                for (const suite of suites) {
                    if (suite.id === plan.rootSuite.id || (suite.id !== byId && !contains(suite.name, needle))) {
                        continue;
                    }

                    hits.push({
                        kind: "suite",
                        id: suite.id,
                        name: suite.name,
                        planId: plan.id,
                        planName: plan.name,
                        path: this.suitePath(suite, byIdMap, plan.rootSuite.id),
                        url: testPlansWebUrl(this.config, { planId: plan.id, suiteId: suite.id }),
                    });
                }
            }
        }

        if (kinds.has("case")) {
            const idClause = byId === undefined ? "" : ` OR [System.Id] = ${byId}`;
            const wiql =
                "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project" +
                ` AND [System.WorkItemType] = 'Test Case'` +
                ` AND ([System.Title] CONTAINS '${escapeWiql(needle)}'${idClause})` +
                " ORDER BY [System.ChangedDate] DESC";
            const ids = await this.rest.queryIds(wiql, top);
            const items = await this.rest.getWorkItems(ids, [F.title, F.state]);

            for (const item of items) {
                hits.push({
                    kind: "case",
                    id: item.id,
                    name: fieldString(item.fields, F.title) ?? "",
                    state: fieldString(item.fields, F.state),
                    url: Api.workItemWebUrl(this.config, item.id),
                });
            }
        }

        return hits.slice(0, Math.max(top, 1) * kinds.size);
    }

    // ============= Writes (dry run unless confirm) =============

    async createPlan(input: PlanInput & { name: string }, confirm: boolean): Promise<WriteOutcome<TestPlanSummary>> {
        const body = {
            name: input.name,
            iteration: input.iteration ?? this.config.project,
            areaPath: input.areaPath ?? this.config.project,
            startDate: input.startDate,
            endDate: input.endDate,
            description: input.description,
            state: input.state,
        };

        if (!confirm) {
            return { dryRun: true, requests: [{ method: "POST", what: "create test plan", body }] };
        }

        return { dryRun: false, result: this.summary(await this.rest.createPlan(body)) };
    }

    async updatePlan(ref: PlanRef, input: PlanInput, confirm: boolean): Promise<WriteOutcome<TestPlanSummary>> {
        const body: TestPlanUpdateParams = {
            name: input.name,
            iteration: input.iteration,
            areaPath: input.areaPath,
            startDate: input.startDate,
            endDate: input.endDate,
            description: input.description,
            state: input.state,
        };

        if (Object.values(body).every((value) => value === undefined)) {
            throw new Error("Nothing to change: pass at least one field");
        }

        if (!confirm) {
            return { dryRun: true, requests: [{ method: "PATCH", what: `update test plan ${ref.planId}`, body }] };
        }

        const current = await this.rest.getPlan(ref.planId);
        const updated = await this.rest.updatePlan(ref.planId, { ...body, revision: current.revision });
        return { dryRun: false, result: this.summary(updated) };
    }

    /** Deletes the plan and its suites; Azure DevOps Services keeps them 14 days for a restore. Test cases stay. */
    async deletePlan(ref: PlanRef, confirm: boolean): Promise<WriteOutcome<{ planId: number }>> {
        if (!confirm) {
            return {
                dryRun: true,
                requests: [
                    {
                        method: "DELETE",
                        what: `delete test plan ${ref.planId} and its suites (14 days in the recycle bin)`,
                    },
                ],
            };
        }

        await this.rest.deletePlan(ref.planId);
        return { dryRun: false, result: { planId: ref.planId } };
    }

    /** A suite under `parentId`, the plan's root suite by default. */
    async createSuite(
        input: {
            planId: number;
            parentId?: number;
            name: string;
            kind?: SuiteKind;
            requirementId?: number;
            query?: string;
        },
        confirm: boolean
    ): Promise<WriteOutcome<SuiteRef & { name: string }>> {
        const kind = input.kind ?? "static";

        if (kind === "requirement" && input.requirementId === undefined) {
            throw new Error("A requirement-based suite needs the requirement's work item id");
        }

        if (kind === "query" && !input.query) {
            throw new Error("A query-based suite needs a WIQL query");
        }

        const parentId = input.parentId ?? (await this.rest.getPlan(input.planId)).rootSuite.id;
        const body = {
            name: input.name,
            suiteType: SUITE_TYPE[kind],
            parentSuite: { id: parentId },
            requirementId: input.requirementId,
            queryString: input.query,
        };

        if (!confirm) {
            return { dryRun: true, requests: [{ method: "POST", what: `create suite in plan ${input.planId}`, body }] };
        }

        const created = await this.rest.createSuite(input.planId, body);
        return { dryRun: false, result: { planId: input.planId, suiteId: created.id, name: created.name } };
    }

    /** Rename, or move under another parent suite of the same plan. */
    async updateSuite(
        ref: SuiteRef,
        input: { name?: string; parentId?: number; query?: string },
        confirm: boolean
    ): Promise<WriteOutcome<SuiteRef & { name: string; parentId?: number }>> {
        if (input.name === undefined && input.parentId === undefined && input.query === undefined) {
            throw new Error("Nothing to change: pass a new name, a new parent or a query");
        }

        if (input.parentId === ref.suiteId) {
            throw new Error("A suite cannot be its own parent");
        }

        const body = {
            name: input.name,
            parentSuite: input.parentId === undefined ? undefined : { id: input.parentId },
            queryString: input.query,
        };

        if (!confirm) {
            return { dryRun: true, requests: [{ method: "PATCH", what: `update suite ${ref.suiteId}`, body }] };
        }

        const current = await this.rest.getSuite(ref.planId, ref.suiteId);
        const updated = await this.rest.updateSuite(ref.planId, ref.suiteId, { ...body, revision: current.revision });
        return {
            dryRun: false,
            result: { ...ref, name: updated.name, parentId: updated.parentSuite?.id },
        };
    }

    /** Deletes the suite and its child suites (14 days in the recycle bin). The Test Case work items stay. */
    async deleteSuite(ref: SuiteRef, confirm: boolean): Promise<WriteOutcome<SuiteRef>> {
        if (!confirm) {
            return {
                dryRun: true,
                requests: [
                    {
                        method: "DELETE",
                        what: `delete suite ${ref.suiteId} and its child suites (14 days in the recycle bin)`,
                    },
                ],
            };
        }

        await this.rest.deleteSuite(ref.planId, ref.suiteId);
        return { dryRun: false, result: ref };
    }

    async addTestCases(
        ref: SuiteRef,
        ids: readonly number[],
        confirm: boolean
    ): Promise<WriteOutcome<SuiteRef & { added: number[] }>> {
        if (!confirm) {
            return {
                dryRun: true,
                requests: [
                    {
                        method: "POST",
                        what: `add test cases to suite ${ref.suiteId}`,
                        body: ids.map((id) => ({ workItem: { id } })),
                    },
                ],
            };
        }

        const added = await this.rest.addTestCases(ref.planId, ref.suiteId, ids);

        if (added.length === 0) {
            throw new Error(
                `Azure DevOps added none of ${ids.join(",")} to suite ${ref.suiteId}; check the ids are Test Case work items`
            );
        }

        return { dryRun: false, result: { ...ref, added: added.map((item) => item.workItem.id) } };
    }

    async removeTestCases(
        ref: SuiteRef,
        ids: readonly number[],
        confirm: boolean
    ): Promise<WriteOutcome<SuiteRef & { removed: number[] }>> {
        if (!confirm) {
            return {
                dryRun: true,
                requests: [{ method: "DELETE", what: `remove test cases ${ids.join(",")} from suite ${ref.suiteId}` }],
            };
        }

        await this.rest.removeTestCases(ref.planId, ref.suiteId, ids);
        return { dryRun: false, result: { ...ref, removed: [...ids] } };
    }

    /** A Test Case work item, added to a suite when one is named. */
    async createTestCase(
        input: TestCaseInput & { title: string; suite?: SuiteRef },
        confirm: boolean
    ): Promise<WriteOutcome<{ id: number; url: string; suite?: SuiteRef }>> {
        const operations = this.testCaseOperations(input);
        const requests: PlannedRequest[] = [{ method: "POST", what: "create Test Case work item", body: operations }];

        if (input.suite) {
            requests.push({ method: "POST", what: `add the new test case to suite ${input.suite.suiteId}` });
        }

        if (!confirm) {
            return { dryRun: true, requests };
        }

        const created = await this.rest.createTestCase(operations);

        if (input.suite) {
            try {
                const added = await this.rest.addTestCases(input.suite.planId, input.suite.suiteId, [created.id]);
                if (!added.some((item) => item.workItem.id === created.id)) {
                    throw new Error("The suite response did not include the created test case");
                }
            } catch (error) {
                throw new Error(
                    `Test Case ${created.id} was created but could not be added to suite ${input.suite.suiteId}. ` +
                        `Retry with: tools azure-devops testplan suite add ${input.suite.planId} ${input.suite.suiteId} --cases ${created.id} --confirm`,
                    { cause: error }
                );
            }
        }

        return {
            dryRun: false,
            result: { id: created.id, url: Api.workItemWebUrl(this.config, created.id), suite: input.suite },
        };
    }

    /** `rev` refuses the update when someone else changed the work item since. */
    async updateTestCase(
        id: number,
        input: TestCaseInput & { rev?: number },
        confirm: boolean
    ): Promise<WriteOutcome<{ id: number; rev: number }>> {
        const operations = this.testCaseOperations(input);

        if (operations.length === 0) {
            throw new Error("Nothing to change: pass at least one field or --steps");
        }

        operations.unshift({ op: "test", path: "/fields/System.WorkItemType", value: "Test Case" });

        if (input.rev !== undefined) {
            operations.unshift({ op: "test", path: "/rev", value: input.rev });
        }

        if (!confirm) {
            return { dryRun: true, requests: [{ method: "PATCH", what: `update test case ${id}`, body: operations }] };
        }

        const updated = await this.rest.updateTestCase(id, operations);
        return { dryRun: false, result: { id: updated.id, rev: updated.rev } };
    }

    /** Deletes the Test Case work item for good, with its test points and results. */
    async deleteTestCase(id: number, confirm: boolean): Promise<WriteOutcome<{ id: number }>> {
        if (!confirm) {
            return {
                dryRun: true,
                requests: [{ method: "DELETE", what: `delete test case ${id} for good (with its points and results)` }],
            };
        }

        await this.rest.deleteTestCase(id);
        return { dryRun: false, result: { id } };
    }

    /**
     * Sets the outcome of test points, named by point id or by test case id (every configuration of it).
     * `active` resets the points to active, which clears the outcome.
     */
    async setOutcome(
        input: SuiteRef & { pointIds?: number[]; testCaseIds?: number[]; outcome: PointOutcome | "active" },
        confirm: boolean
    ): Promise<WriteOutcome<TestPointRow[]>> {
        const ids = new Set(input.pointIds ?? []);

        if (input.testCaseIds?.length) {
            const wanted = new Set(input.testCaseIds);
            const points = await this.rest.listPoints(input.planId, input.suiteId);

            for (const point of points) {
                if (wanted.has(point.testCaseReference.id)) {
                    ids.add(point.id);
                }
            }
        }

        if (ids.size === 0) {
            throw new Error("No test point matched: pass point ids, or test case ids that are in this suite");
        }

        const updates = [...ids].map((id) =>
            input.outcome === "active" ? { id, isActive: true } : { id, results: { outcome: input.outcome } }
        );

        if (!confirm) {
            return {
                dryRun: true,
                requests: [{ method: "PATCH", what: `update test points of suite ${input.suiteId}`, body: updates }],
            };
        }

        const updated = await this.rest.updatePoints(input.planId, input.suiteId, updates);
        return { dryRun: false, result: updated.map((point) => this.pointRow(point)) };
    }

    // ============= Internals =============

    private planUrl(planId: number): string {
        return testPlansWebUrl(this.config, { planId });
    }

    private summary(plan: TestPlanApi): TestPlanSummary {
        return {
            id: plan.id,
            name: plan.name,
            state: plan.state,
            owner: identityName(plan.owner),
            areaPath: plan.areaPath,
            iteration: plan.iteration,
            startDate: plan.startDate,
            endDate: plan.endDate,
            rootSuiteId: plan.rootSuite.id,
            url: this.planUrl(plan.id),
        };
    }

    private suiteNode(suite: TestSuiteApi, counts: Map<number, number> | undefined): SuiteNode {
        return {
            id: suite.id,
            name: suite.name,
            kind: SUITE_KIND[suite.suiteType] ?? "static",
            parentId: suite.parentSuite?.id,
            testCaseCount: counts ? (counts.get(suite.id) ?? 0) : undefined,
            requirementId: suite.requirementId,
            query: suite.queryString,
            children: (suite.children ?? []).map((child) => this.suiteNode(child, counts)),
        };
    }

    private suitePath(suite: TestSuiteApi, byId: Map<number, TestSuiteApi>, rootId: number): string[] {
        const path: string[] = [];
        const seen = new Set<number>();
        let current: TestSuiteApi | undefined = suite;

        while (current && current.id !== rootId && !seen.has(current.id)) {
            seen.add(current.id);
            path.unshift(current.name);
            current = current.parentSuite ? byId.get(current.parentSuite.id) : undefined;
        }

        return path;
    }

    private pointRow(point: TestPointApi): TestPointRow {
        const runBy = point.results.lastResultDetails?.runBy;
        const completed = point.results.lastResultDetails?.dateCompleted;

        return {
            id: point.id,
            testCaseId: point.testCaseReference.id,
            testCaseTitle: point.testCaseReference.name,
            configuration: point.configuration.name,
            tester: identityName(point.tester),
            outcome: point.results.outcome,
            state: point.results.state,
            active: point.isActive,
            lastRunBy: identityName(runBy),
            lastRunDate: completed && !completed.startsWith("0001-") ? completed : undefined,
        };
    }

    /**
     * The route is organization-wide, and it answers 404 for everyone when one of the suites lives in a
     * project the user cannot read. Null then: the suites are unknown, not none.
     */
    private async suitesOf(testCaseId: number): Promise<TestCaseSuiteRef[] | null> {
        let suites: TestSuiteApi[];

        try {
            suites = await this.rest.suitesOfTestCase(testCaseId);
        } catch (error) {
            logger.warn({ error, testCaseId }, "[test-plans] could not read the suites of the test case");
            return null;
        }

        return suites.map((suite) => ({
            planId: suite.plan.id,
            planName: suite.plan.name,
            suiteId: suite.id,
            suiteName: suite.name,
        }));
    }

    private async expandSharedSteps(steps: TestStep[]): Promise<TestStep[]> {
        const ids = [...new Set(steps.flatMap((step) => (step.kind === "shared" ? [step.sharedStepsId] : [])))];

        if (ids.length === 0) {
            return steps;
        }

        const items = new Map<number, WorkItemFieldsApi>(
            (await this.rest.getWorkItems(ids, [F.title, F.steps])).map((item) => [item.id, item])
        );

        return steps.map((step) => {
            if (step.kind !== "shared") {
                return step;
            }

            const item = items.get(step.sharedStepsId);

            if (!item) {
                return step;
            }

            const nested = parseStepsXml(fieldString(item.fields, F.steps)).filter((sub) => sub.kind === "step");
            return { ...step, title: fieldString(item.fields, F.title), steps: nested };
        });
    }

    private testCaseOperations(input: TestCaseInput): JsonPatchOperation[] {
        const set: [string, unknown][] = [
            [F.title, input.title],
            [F.steps, input.steps ? buildStepsXml(input.steps) : undefined],
            [F.priority, input.priority],
            [F.state, input.state],
            [F.area, input.areaPath],
            [F.iteration, input.iterationPath],
            [F.assignedTo, input.assignedTo],
            [F.description, input.description === undefined ? undefined : markdownToStepHtml(input.description)],
            ...(input.fields ?? []).map((field): [string, unknown] => [field.name, field.value]),
        ];

        return set
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => ({ op: "add", path: `/fields/${name}`, value }));
    }
}

/** The service on the real transport. */
export function testPlans(config: AzureConfig): TestPlans {
    return new TestPlans(new Api(config), config);
}
