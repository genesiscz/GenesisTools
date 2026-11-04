import type { PlannedRequest, SearchHit } from "@app/azure-devops/lib/test-plans/service";
import { renderStepsMarkdown } from "@app/azure-devops/lib/test-plans/steps";
import type {
    SuiteNode,
    TestCaseDetails,
    TestPlanDetails,
    TestPlanSummary,
    TestPointRow,
    TestSuiteDetails,
} from "@app/azure-devops/lib/test-plans/types";
import { tableCell } from "@app/azure-devops/lib/work-item-markdown";
import { SafeJSON } from "@genesiscz/utils/json";

function day(value: string | undefined): string {
    return value ? value.slice(0, 10) : "";
}

function table(headers: string[], rows: string[][]): string {
    return [
        `| ${headers.join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...rows.map((row) => `| ${row.map((cell) => tableCell(cell)).join(" | ")} |`),
    ].join("\n");
}

export function renderPlanList(plans: readonly TestPlanSummary[]): string {
    if (plans.length === 0) {
        return "_No test plans match._";
    }

    return table(
        ["ID", "Name", "State", "Owner", "Iteration", "Dates"],
        plans.map((plan) => [
            String(plan.id),
            plan.name,
            plan.state ?? "",
            plan.owner ?? "",
            plan.iteration ?? "",
            plan.startDate || plan.endDate ? `${day(plan.startDate)} to ${day(plan.endDate)}` : "",
        ])
    );
}

function kindLabel(node: { kind: SuiteNode["kind"]; requirementId?: number }): string {
    if (node.kind === "requirement") {
        return ` [requirement #${node.requirementId ?? "?"}]`;
    }

    return node.kind === "query" ? " [query]" : "";
}

/** The suite tree as the Define tab shows it: `- Name (count) #id`. */
export function renderSuiteTree(root: SuiteNode): string {
    const lines: string[] = [];

    const walk = (node: SuiteNode, depth: number): void => {
        const count = node.testCaseCount ? ` (${node.testCaseCount})` : "";
        lines.push(`${"  ".repeat(depth)}- ${node.name}${count}${kindLabel(node)} \`#${node.id}\``);

        for (const child of node.children) {
            walk(child, depth + 1);
        }
    };

    walk(root, 0);
    return lines.join("\n");
}

export function totalTestCases(root: SuiteNode): number | undefined {
    if (root.testCaseCount === undefined) {
        return undefined;
    }

    return root.children.reduce((sum, child) => sum + (totalTestCases(child) ?? 0), root.testCaseCount);
}

export function renderPlan(plan: TestPlanDetails): string {
    const total = totalTestCases(plan.suites);
    const lines = [
        `# Test plan ${plan.id}: ${plan.name}`,
        "",
        `- State: ${plan.state ?? "?"}`,
        `- Owner: ${plan.owner ?? "?"}`,
        `- Area: ${plan.areaPath ?? "?"}`,
        `- Iteration: ${plan.iteration ?? "?"}`,
        `- Dates: ${day(plan.startDate) || "?"} to ${day(plan.endDate) || "?"}`,
        `- Updated: ${day(plan.updatedDate) || "?"}${plan.updatedBy ? ` by ${plan.updatedBy}` : ""}`,
        `- Root suite: ${plan.rootSuiteId}`,
        `- Link: ${plan.url}`,
    ];

    if (plan.description) {
        lines.push("", "## Description", "", plan.description);
    }

    const counts =
        plan.countSource === "none"
            ? " (no test case counts: no count route answered)"
            : total === undefined
              ? ""
              : ` (${total} test cases)`;
    lines.push("", `## Suites${counts}`, "", renderSuiteTree(plan.suites));
    return lines.join("\n");
}

export function renderSuite(suite: TestSuiteDetails): string {
    const lines = [
        `# Suite ${suite.id}: ${suite.name}`,
        "",
        `- Plan: ${suite.plan.name} (${suite.plan.id})`,
        `- Type: ${suite.kind}${suite.requirementId ? ` (requirement #${suite.requirementId})` : ""}`,
        `- Parent: ${suite.parent ? `${suite.parent.name} (${suite.parent.id})` : "none (root suite)"}`,
        `- Updated: ${day(suite.lastUpdatedDate) || "?"}${suite.lastUpdatedBy ? ` by ${suite.lastUpdatedBy}` : ""}`,
        `- Link: ${suite.url}`,
    ];

    if (suite.query) {
        lines.push("", "## Query", "", "```sql", suite.query, "```");
    }

    if (suite.children.length > 0) {
        lines.push(
            "",
            "## Child suites",
            "",
            ...suite.children.map((child) => `- ${child.name}${kindLabel(child)} \`#${child.id}\``)
        );
    }

    lines.push("", `## Test cases (${suite.testCases.length})`, "");

    if (suite.testCases.length === 0) {
        lines.push("_None._");
    } else {
        lines.push(
            table(
                ["ID", "Title", "State", "Priority", "Assigned to", "Points"],
                suite.testCases.map((item) => [
                    String(item.id),
                    item.title,
                    item.state ?? "",
                    item.priority === undefined ? "" : String(item.priority),
                    item.assignedTo ?? "",
                    item.points.map((point) => `${point.id} ${point.configuration ?? ""}`.trim()).join(", "),
                ])
            )
        );
    }

    return lines.join("\n");
}

export function renderPoints(points: readonly TestPointRow[]): string {
    if (points.length === 0) {
        return "_No test points._";
    }

    return table(
        ["Point", "Test case", "Configuration", "Tester", "Outcome", "Last run"],
        points.map((point) => [
            String(point.id),
            `${point.testCaseId} ${point.testCaseTitle}`,
            point.configuration,
            point.tester ?? "",
            point.active ? point.outcome : `${point.outcome} (inactive)`,
            point.lastRunDate ? `${day(point.lastRunDate)}${point.lastRunBy ? ` by ${point.lastRunBy}` : ""}` : "",
        ])
    );
}

export function renderTestCase(item: TestCaseDetails): string {
    const lines = [
        `# Test case ${item.id}: ${item.title}`,
        "",
        `- State: ${item.state ?? "?"}`,
        `- Priority: ${item.priority ?? "?"}`,
        `- Assigned to: ${item.assignedTo ?? "nobody"}`,
        `- Area: ${item.areaPath ?? "?"}`,
        `- Iteration: ${item.iterationPath ?? "?"}`,
        `- Automation: ${item.automationStatus ?? "?"}`,
        `- Rev: ${item.rev}`,
        `- Link: ${item.url}`,
    ];

    if (item.description) {
        lines.push("", "## Description", "", item.description);
    }

    lines.push("", "## Steps", "", renderStepsMarkdown(item.steps));

    const { names, rows, sharedParameterSetIds } = item.parameters;

    if (names.length > 0) {
        lines.push("", "## Parameters", "");

        if (sharedParameterSetIds?.length) {
            lines.push(`Shared parameter sets: ${sharedParameterSetIds.map((id) => `#${id}`).join(", ")}`, "");
        }

        lines.push(
            rows.length > 0
                ? table(
                      names,
                      rows.map((row) => names.map((name) => row[name] ?? ""))
                  )
                : names.map((name) => `- @${name}`).join("\n")
        );
    }

    lines.push("", "## In suites", "");
    lines.push(
        item.suites === null
            ? "_Unknown: Azure DevOps refused the lookup (a suite may be in a project you cannot read)._"
            : item.suites.length === 0
              ? "_None._"
              : item.suites
                    .map((ref) => `- ${ref.planName} (${ref.planId}) / ${ref.suiteName} \`#${ref.suiteId}\``)
                    .join("\n")
    );

    return lines.join("\n");
}

export function renderSearch(hits: readonly SearchHit[]): string {
    if (hits.length === 0) {
        return "_Nothing found._";
    }

    return table(
        ["Kind", "ID", "Name", "Where", "State"],
        hits.map((hit) => [
            hit.kind,
            String(hit.id),
            hit.name,
            hit.planName
                ? `${hit.planName} (${hit.planId})${hit.path?.length ? ` / ${hit.path.join(" / ")}` : ""}`
                : "",
            hit.state ?? "",
        ])
    );
}

/** What a write would send, printed by a dry run. */
export function renderPlannedRequests(requests: readonly PlannedRequest[]): string {
    const lines = ["Dry run: nothing was sent. Add --confirm to send:", ""];

    for (const request of requests) {
        lines.push(`- ${request.method} ${request.what}`);

        if (request.body !== undefined) {
            lines.push("", "```json", SafeJSON.stringify(request.body, null, 2), "```", "");
        }
    }

    return lines.join("\n").trimEnd();
}
