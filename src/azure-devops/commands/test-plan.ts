import { readFileSync } from "node:fs";
import { resolveWorkItemId } from "@app/azure-devops/lib/comments";
import { type SnapshotName, saveSnapshot } from "@app/azure-devops/lib/test-plans/files";
import { parseIdList, parsePlanRef, parseSuiteRef, type SuiteRef } from "@app/azure-devops/lib/test-plans/refs";
import {
    renderPlan,
    renderPlanList,
    renderPlannedRequests,
    renderPoints,
    renderSearch,
    renderSuite,
    renderTestCase,
} from "@app/azure-devops/lib/test-plans/render";
import {
    type PlanInput,
    type SearchKind,
    type TestCaseInput,
    type TestPlans,
    testPlans,
    type WriteOutcome,
} from "@app/azure-devops/lib/test-plans/service";
import { parseStepsInput } from "@app/azure-devops/lib/test-plans/steps";
import { POINT_OUTCOMES, type SuiteKind } from "@app/azure-devops/lib/test-plans/types";
import { parseFieldSpec } from "@app/azure-devops/lib/work-item-update";
import { requireConfig } from "@app/azure-devops/utils";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { type Command, Option } from "commander";
import pc from "picocolors";

const TOOL = "tools azure-devops";
const FORMATS = ["md", "json"] as const;
const SEARCH_KINDS: readonly SearchKind[] = ["plan", "suite", "case"];
const SUITE_KINDS: readonly SuiteKind[] = ["static", "requirement", "query"];
const OUTCOMES = [...POINT_OUTCOMES, "active"] as const;

interface FormatOptions {
    format: string;
    save?: boolean;
}

function isOneOf<T extends string>(value: string | undefined, values: readonly T[]): value is T {
    return values.some((item) => item === value);
}

/** An enumerated value, or null after printing the possible values (exit code 1). */
function pick<T extends string>(
    value: string | undefined,
    values: readonly T[],
    flag: string,
    subcommand: string[]
): T | null {
    if (isOneOf(value, values)) {
        return value;
    }

    out.error(suggestEnumFlag(`${TOOL} ${subcommand.join(" ")}`, flag, values, { subcommand, given: value }));
    process.exitCode = 1;
    return null;
}

function withFormat(command: Command): Command {
    return command.addOption(new Option("-f, --format <format>", "Output format").choices(FORMATS).default("md"));
}

function withSave(command: Command): Command {
    return withFormat(command).option("--save", "Write the snapshot under .claude/azure/testplans/");
}

function withConfirm(command: Command): Command {
    return withFormat(command).option("--confirm", "Send the change (without it, print what would be sent)");
}

function readText(path: string): string {
    return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!/^\d+$/.test(value) || Number(value) <= 0) {
        throw new Error(`${flag} expects a positive whole number, got '${value}'`);
    }

    return Number(value);
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/** Prints a read result as markdown (and saves the snapshot) or as JSON. */
export async function show<T>({
    options,
    subcommand,
    data,
    markdown,
    snapshot,
    writeSnapshot = saveSnapshot,
}: {
    options: FormatOptions;
    subcommand: string[];
    data: T;
    markdown: (data: T) => string;
    snapshot?: SnapshotName;
    writeSnapshot?: typeof saveSnapshot;
}): Promise<void> {
    const format = pick(options.format, FORMATS, "--format", subcommand);

    if (!format) {
        return;
    }

    const text = format === "md" || (snapshot && options.save === true) ? markdown(data) : "";
    if (format === "json") {
        out.result(data);
    } else {
        out.println(text);
    }

    if (snapshot && options.save === true) {
        const path = await writeSnapshot(snapshot, text, data);
        out.printlnErr(pc.dim(`\nSaved: ${path}`));
    }
}

/** Prints a write result, or the requests a dry run would send. */
function report<T>(
    options: FormatOptions,
    subcommand: string[],
    outcome: WriteOutcome<T>,
    done: (result: T) => string
): void {
    const format = pick(options.format, FORMATS, "--format", subcommand);

    if (!format) {
        return;
    }

    if (format === "json") {
        out.result(outcome);
        return;
    }

    out.println(
        outcome.dryRun ? renderPlannedRequests(outcome.requests) : `${pc.green("Done:")} ${done(outcome.result)}`
    );
}

function service(): { plans: TestPlans; org: string } {
    const config = requireConfig();
    return { plans: testPlans(config), org: config.org };
}

function suiteRefOf(input: string, suiteArg: string | undefined, org: string): SuiteRef {
    return parseSuiteRef(input, suiteArg, org);
}

interface PlanFlags extends FormatOptions {
    name?: string;
    iteration?: string;
    area?: string;
    start?: string;
    end?: string;
    description?: string;
    state?: string;
    confirm?: boolean;
}

function planInput(options: PlanFlags, subcommand: string[]): PlanInput | null {
    let state: PlanInput["state"];

    if (options.state !== undefined) {
        const picked = pick(options.state, ["Active", "Inactive"] as const, "--state", subcommand);

        if (!picked) {
            return null;
        }

        state = picked;
    }

    return {
        name: options.name,
        iteration: options.iteration,
        areaPath: options.area,
        startDate: options.start,
        endDate: options.end,
        description: options.description === undefined ? undefined : readText(options.description),
        state,
    };
}

function withPlanFields(command: Command): Command {
    return command
        .option("--name <name>", "Plan name")
        .option("--iteration <path>", "Iteration path (default for a new plan: the project's root iteration)")
        .option("--area <path>", "Area path (default for a new plan: the project's root area)")
        .option("--start <date>", "Start date (ISO, e.g. 2026-11-04)")
        .option("--end <date>", "End date (ISO)")
        .option("--description <file>", "Description from a file ('-' reads stdin)")
        .option("--state <state>", "Active|Inactive");
}

interface CaseFlags extends FormatOptions {
    title?: string;
    steps?: string;
    priority?: string;
    state?: string;
    area?: string;
    iteration?: string;
    assignedTo?: string;
    description?: string;
    field: string[];
    confirm?: boolean;
}

function caseInput(options: CaseFlags): TestCaseInput {
    return {
        title: options.title,
        steps: options.steps === undefined ? undefined : parseStepsInput(readText(options.steps)),
        priority: positiveInt(options.priority, "--priority"),
        state: options.state,
        areaPath: options.area,
        iterationPath: options.iteration,
        assignedTo: options.assignedTo,
        description: options.description === undefined ? undefined : readText(options.description),
        fields: options.field.map((spec) => parseFieldSpec(spec, readText)),
    };
}

function withCaseFields(command: Command): Command {
    return command
        .option("--title <title>", "Title")
        .option("--steps <file>", "Steps as a numbered markdown list or JSON ('-' reads stdin)")
        .option("--priority <n>", "Priority (1 is highest)")
        .option("--state <state>", "State, e.g. Design, Ready, Closed")
        .option("--area <path>", "Area path")
        .option("--iteration <path>", "Iteration path")
        .option("--assigned-to <user>", "Assignee (display name or e-mail)")
        .option("--description <file>", "Description as markdown, from a file ('-' reads stdin)")
        .option(
            "--field <name=value>",
            "Any other field by reference name; repeat (value @file reads a file)",
            collect,
            []
        );
}

export function registerTestPlanCommand(program: Command, caseService: typeof service = service): void {
    const testplan = program
        .command("testplan")
        .description("Test plans, suites, test cases and test points (the Test Plans hub)");

    withFormat(
        testplan
            .command("list")
            .alias("ls")
            .description("List the project's test plans")
            .option("--name <text>", "Only plans whose name holds the text (or with this id)")
            .option("--owner <text>", "Only plans whose owner name, e-mail or id holds the text")
            .option("--active", "Only active plans")
    ).action(async (options: FormatOptions & { name?: string; owner?: string; active?: boolean }) => {
        const { plans } = service();
        const list = await plans.listPlans({ name: options.name, owner: options.owner, activeOnly: options.active });
        await show({ options, subcommand: ["testplan", "list"], data: list, markdown: renderPlanList });
    });

    withSave(
        testplan
            .command("show")
            .description("A plan with its suite tree and the test case count of each suite")
            .argument("<plan>", "Plan id or Test Plans URL")
    ).action(async (input: string, options: FormatOptions) => {
        const { plans, org } = service();
        const ref = parsePlanRef(input, org);
        const plan = await plans.planDetails(ref);
        await show({
            options,
            subcommand: ["testplan", "show"],
            data: plan,
            markdown: renderPlan,
            snapshot: `plan-${plan.id}`,
        });
    });

    withFormat(
        testplan
            .command("search")
            .description("Find plans, suites and test cases by name or id")
            .argument("<text>", "Part of the name, or an id")
            .option("--kind <kinds>", `Comma-separated: ${SEARCH_KINDS.join(",")} (default: all)`)
            .option("--plan <id>", "Search the suites of this plan only")
            .option("--top <n>", "At most this many hits per kind", "50")
    ).action(async (text: string, options: FormatOptions & { kind?: string; plan?: string; top: string }) => {
        const kinds: SearchKind[] = [];

        for (const kind of (options.kind ?? "").split(",").filter(Boolean)) {
            const picked = pick(kind.trim(), SEARCH_KINDS, "--kind", ["testplan", "search"]);

            if (!picked) {
                return;
            }

            kinds.push(picked);
        }

        const { plans } = service();
        const hits = await plans.search(text, {
            kinds,
            planId: positiveInt(options.plan, "--plan"),
            top: positiveInt(options.top, "--top"),
        });
        await show({ options, subcommand: ["testplan", "search"], data: hits, markdown: renderSearch });
    });

    withConfirm(withPlanFields(testplan.command("create").description("Create a test plan"))).action(
        async (options: PlanFlags) => {
            const input = planInput(options, ["testplan", "create"]);

            if (!input) {
                return;
            }

            if (!input.name) {
                out.error("A new plan needs --name");
                process.exitCode = 1;
                return;
            }

            const { plans } = service();
            const outcome = await plans.createPlan({ ...input, name: input.name }, options.confirm === true);
            report(
                options,
                ["testplan", "create"],
                outcome,
                (plan) => `created plan ${plan.id} "${plan.name}"\n${plan.url}`
            );
        }
    );

    withConfirm(
        withPlanFields(
            testplan
                .command("update")
                .description("Change a test plan's name, state, dates, area or iteration")
                .argument("<plan>", "Plan id or URL")
        )
    ).action(async (planArg: string, options: PlanFlags) => {
        const input = planInput(options, ["testplan", "update"]);

        if (!input) {
            return;
        }

        const { plans, org } = service();
        const outcome = await plans.updatePlan(parsePlanRef(planArg, org), input, options.confirm === true);
        report(options, ["testplan", "update"], outcome, (plan) => `updated plan ${plan.id} "${plan.name}"`);
    });

    withConfirm(
        testplan
            .command("delete")
            .description("Delete a test plan and its suites (test cases stay)")
            .argument("<plan>", "Plan id or URL")
    ).action(async (planArg: string, options: PlanFlags) => {
        const { plans, org } = service();
        const outcome = await plans.deletePlan(parsePlanRef(planArg, org), options.confirm === true);
        report(
            options,
            ["testplan", "delete"],
            outcome,
            ({ planId }) => `deleted plan ${planId} (14 days in the recycle bin)`
        );
    });

    registerSuiteCommands(testplan);
    registerPointCommands(testplan);
    registerCaseCommands(testplan, caseService);
}

function registerSuiteCommands(testplan: Command): void {
    const suite = testplan
        .command("suite")
        .description("Suites: show, create, rename, move, delete, add and remove test cases");

    withSave(
        suite
            .command("show")
            .description("A suite: type, parent, child suites and its test cases")
            .argument("<plan>", "Plan id, or a URL with planId and suiteId")
            .argument("[suite]", "Suite id (when <plan> is an id)")
    ).action(async (planArg: string, suiteArg: string | undefined, options: FormatOptions) => {
        const { plans, org } = service();
        const ref = suiteRefOf(planArg, suiteArg, org);
        const details = await plans.suiteDetails(ref);
        await show({
            options,
            subcommand: ["testplan", "suite", "show"],
            data: details,
            markdown: renderSuite,
            snapshot: `suite-${ref.planId}-${ref.suiteId}`,
        });
    });

    withConfirm(
        suite
            .command("create")
            .description("Create a suite under a parent suite (default: the plan's root suite)")
            .argument("<plan>", "Plan id or URL")
            .requiredOption("--name <name>", "Suite name")
            .option("--parent <suiteId>", "Parent suite id")
            .option("--type [type]", `Suite type: ${SUITE_KINDS.join("|")}`, "static")
            .option("--requirement <id>", "Requirement work item id (type requirement)")
            .option("--query <wiql>", "WIQL query (type query)")
    ).action(
        async (
            planArg: string,
            options: FormatOptions & {
                name: string;
                parent?: string;
                type: string | true;
                requirement?: string;
                query?: string;
                confirm?: boolean;
            }
        ) => {
            const kind = pick(options.type === true ? undefined : options.type, SUITE_KINDS, "--type", [
                "testplan",
                "suite",
                "create",
            ]);

            if (!kind) {
                return;
            }

            const { plans, org } = service();
            const { planId } = parsePlanRef(planArg, org);
            const outcome = await plans.createSuite(
                {
                    planId,
                    parentId: positiveInt(options.parent, "--parent"),
                    name: options.name,
                    kind,
                    requirementId: positiveInt(options.requirement, "--requirement"),
                    query: options.query,
                },
                options.confirm === true
            );
            report(
                options,
                ["testplan", "suite", "create"],
                outcome,
                (created) => `created suite ${created.suiteId} "${created.name}" in plan ${created.planId}`
            );
        }
    );

    withConfirm(
        suite
            .command("update")
            .description("Rename a suite, move it under another parent, or change its query")
            .argument("<plan>", "Plan id, or a URL with planId and suiteId")
            .argument("[suite]", "Suite id (when <plan> is an id)")
            .option("--name <name>", "New name")
            .option("--parent <suiteId>", "Move under this suite of the same plan")
            .option("--query <wiql>", "New query (query-based suites)")
    ).action(
        async (
            planArg: string,
            suiteArg: string | undefined,
            options: FormatOptions & { name?: string; parent?: string; query?: string; confirm?: boolean }
        ) => {
            const { plans, org } = service();
            const outcome = await plans.updateSuite(
                suiteRefOf(planArg, suiteArg, org),
                { name: options.name, parentId: positiveInt(options.parent, "--parent"), query: options.query },
                options.confirm === true
            );
            report(
                options,
                ["testplan", "suite", "update"],
                outcome,
                (updated) => `suite ${updated.suiteId} is "${updated.name}" under ${updated.parentId ?? "?"}`
            );
        }
    );

    withConfirm(
        suite
            .command("delete")
            .description("Delete a suite and its child suites (test cases stay)")
            .argument("<plan>", "Plan id, or a URL with planId and suiteId")
            .argument("[suite]", "Suite id (when <plan> is an id)")
    ).action(async (planArg: string, suiteArg: string | undefined, options: FormatOptions & { confirm?: boolean }) => {
        const { plans, org } = service();
        const outcome = await plans.deleteSuite(suiteRefOf(planArg, suiteArg, org), options.confirm === true);
        report(
            options,
            ["testplan", "suite", "delete"],
            outcome,
            (ref) => `deleted suite ${ref.suiteId} (14 days in the recycle bin)`
        );
    });

    for (const [name, description] of [
        ["add", "Add existing test cases to a suite"],
        ["remove", "Remove test cases from a suite (the work items stay)"],
    ] as const) {
        withConfirm(
            suite
                .command(name)
                .description(description)
                .argument("<plan>", "Plan id, or a URL with planId and suiteId")
                .argument("[suite]", "Suite id (when <plan> is an id)")
                .requiredOption("--cases <ids...>", "Test case ids (comma or space separated)")
        ).action(
            async (
                planArg: string,
                suiteArg: string | undefined,
                options: FormatOptions & { cases: string[]; confirm?: boolean }
            ) => {
                const { plans, org } = service();
                const ref = suiteRefOf(planArg, suiteArg, org);
                const ids = parseIdList(options.cases, "test case");

                if (name === "add") {
                    const outcome = await plans.addTestCases(ref, ids, options.confirm === true);
                    report(
                        options,
                        ["testplan", "suite", name],
                        outcome,
                        (result) => `added ${result.added.join(", ")} to suite ${result.suiteId}`
                    );
                    return;
                }

                const outcome = await plans.removeTestCases(ref, ids, options.confirm === true);
                report(
                    options,
                    ["testplan", "suite", name],
                    outcome,
                    (result) => `removed ${result.removed.join(", ")} from suite ${result.suiteId}`
                );
            }
        );
    }
}

function registerPointCommands(testplan: Command): void {
    withFormat(
        testplan
            .command("points")
            .description("The Execute tab of a suite: test points with outcome, tester and configuration")
            .argument("<plan>", "Plan id, or a URL with planId and suiteId")
            .argument("[suite]", "Suite id (when <plan> is an id)")
            .option("--case <id>", "Only the points of this test case")
    ).action(async (planArg: string, suiteArg: string | undefined, options: FormatOptions & { case?: string }) => {
        const { plans, org } = service();
        const points = await plans.points(suiteRefOf(planArg, suiteArg, org), {
            testCaseId: positiveInt(options.case, "--case"),
        });
        await show({ options, subcommand: ["testplan", "points"], data: points, markdown: renderPoints });
    });

    withConfirm(
        testplan
            .command("outcome")
            .description("Set the outcome of test points (or 'active' to reset them)")
            .argument("<plan>", "Plan id, or a URL with planId and suiteId")
            .argument("[suite]", "Suite id (when <plan> is an id)")
            .option("--outcome [outcome]", OUTCOMES.join("|"))
            .option("--points <ids...>", "Test point ids")
            .option("--cases <ids...>", "Test case ids: every configuration's point of each")
    ).action(
        async (
            planArg: string,
            suiteArg: string | undefined,
            options: FormatOptions & { outcome?: string | true; points?: string[]; cases?: string[]; confirm?: boolean }
        ) => {
            const outcomeValue = pick(options.outcome === true ? undefined : options.outcome, OUTCOMES, "--outcome", [
                "testplan",
                "outcome",
            ]);

            if (!outcomeValue) {
                return;
            }

            if (!options.points && !options.cases) {
                out.error("Name the points: --points <ids> or --cases <ids>");
                process.exitCode = 1;
                return;
            }

            const { plans, org } = service();
            const result = await plans.setOutcome(
                {
                    ...suiteRefOf(planArg, suiteArg, org),
                    pointIds: options.points ? parseIdList(options.points, "test point") : undefined,
                    testCaseIds: options.cases ? parseIdList(options.cases, "test case") : undefined,
                    outcome: outcomeValue,
                },
                options.confirm === true
            );
            report(options, ["testplan", "outcome"], result, (rows) => `\n${renderPoints(rows)}`);
        }
    );
}

function registerCaseCommands(testplan: Command, caseService: typeof service): void {
    const testCase = testplan
        .command("case")
        .description("Test case work items: show with parsed steps, create, update, delete");

    withSave(
        testCase
            .command("show")
            .description("A test case: fields, numbered steps with expected results, shared steps, parameters, suites")
            .argument("<id>", "Test case id or work item URL")
    ).action(async (input: string, options: FormatOptions) => {
        const { plans, org } = service();
        const id = resolveWorkItemId(input, org);
        const details = await plans.testCase(id);
        await show({
            options,
            subcommand: ["testplan", "case", "show"],
            data: details,
            markdown: renderTestCase,
            snapshot: `case-${id}`,
        });
    });

    withConfirm(
        withCaseFields(
            testCase.command("create").description("Create a test case, and add it to a suite when one is named")
        )
            .option("--plan <plan>", "Add to a suite of this plan (id, or a URL with planId and suiteId)")
            .option("--suite <id>", "Suite id (with --plan as an id)")
    ).action(async (options: CaseFlags & { plan?: string; suite?: string }) => {
        if (!options.title) {
            out.error("A new test case needs --title");
            process.exitCode = 1;
            return;
        }

        if (options.suite && !options.plan) {
            out.error("--suite requires --plan");
            process.exitCode = 1;
            return;
        }

        const { plans, org } = caseService();
        const suite = options.plan ? suiteRefOf(options.plan, options.suite, org) : undefined;
        const outcome = await plans.createTestCase(
            { ...caseInput(options), title: options.title, suite },
            options.confirm === true
        );
        report(
            options,
            ["testplan", "case", "create"],
            outcome,
            (created) =>
                `created test case ${created.id}${created.suite ? ` in suite ${created.suite.suiteId}` : ""}\n${created.url}`
        );
    });

    withConfirm(
        withCaseFields(
            testCase
                .command("update")
                .description("Change a test case's fields or replace its steps")
                .argument("<id>", "Test case id or work item URL")
        ).option("--rev <n>", "Refuse the update unless the work item is still at this rev")
    ).action(async (input: string, options: CaseFlags & { rev?: string }) => {
        const { plans, org } = service();
        const id = resolveWorkItemId(input, org);
        const outcome = await plans.updateTestCase(
            id,
            { ...caseInput(options), rev: positiveInt(options.rev, "--rev") },
            options.confirm === true
        );
        report(
            options,
            ["testplan", "case", "update"],
            outcome,
            (updated) => `test case ${updated.id} is at rev ${updated.rev}`
        );
    });

    withConfirm(
        testCase
            .command("delete")
            .description("Delete a test case for good, with its points and results (no recycle bin)")
            .argument("<id>", "Test case id or work item URL")
    ).action(async (input: string, options: FormatOptions & { confirm?: boolean }) => {
        const { plans, org } = service();
        const outcome = await plans.deleteTestCase(resolveWorkItemId(input, org), options.confirm === true);
        report(options, ["testplan", "case", "delete"], outcome, ({ id }) => `deleted test case ${id}`);
    });
}
