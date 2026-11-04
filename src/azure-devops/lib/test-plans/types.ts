/** Test Plans: the domain shapes the CLI prints and the commands pass. The wire shapes stay in `rest.ts`. */

import type { TestCaseParameters, TestStep } from "@app/azure-devops/lib/test-plans/steps";

/** Point outcomes the web UI offers in the Execute view. */
export const POINT_OUTCOMES = [
    "passed",
    "failed",
    "blocked",
    "notApplicable",
    "paused",
    "inProgress",
    "unspecified",
] as const;
export type PointOutcome = (typeof POINT_OUTCOMES)[number];

// ============= What the CLI prints =============

export type SuiteKind = "static" | "requirement" | "query";

export interface SuiteNode {
    id: number;
    name: string;
    kind: SuiteKind;
    parentId?: number;
    /** Test cases directly in the suite; undefined when no count source answered. */
    testCaseCount?: number;
    requirementId?: number;
    query?: string;
    children: SuiteNode[];
}

export interface TestPlanSummary {
    id: number;
    name: string;
    state?: string;
    owner?: string;
    areaPath?: string;
    iteration?: string;
    startDate?: string;
    endDate?: string;
    rootSuiteId: number;
    url: string;
}

export interface TestPlanDetails extends TestPlanSummary {
    description?: string;
    revision?: number;
    updatedBy?: string;
    updatedDate?: string;
    suites: SuiteNode;
    /** Where the counts came from, or why there are none. */
    countSource: "count" | "legacy" | "none";
}

export interface SuiteTestCaseRow {
    id: number;
    title: string;
    state?: string;
    priority?: number;
    assignedTo?: string;
    points: { id: number; configuration?: string; tester?: string }[];
}

export interface TestSuiteDetails {
    plan: { id: number; name: string };
    id: number;
    name: string;
    kind: SuiteKind;
    parent?: { id: number; name: string };
    requirementId?: number;
    query?: string;
    revision?: number;
    lastUpdatedDate?: string;
    lastUpdatedBy?: string;
    children: { id: number; name: string; kind: SuiteKind }[];
    testCases: SuiteTestCaseRow[];
    url: string;
}

export interface TestPointRow {
    id: number;
    testCaseId: number;
    testCaseTitle: string;
    configuration: string;
    tester?: string;
    outcome: string;
    state?: string;
    active: boolean;
    lastRunBy?: string;
    lastRunDate?: string;
}

export interface TestCaseSuiteRef {
    planId: number;
    planName: string;
    suiteId: number;
    suiteName: string;
}

export interface TestCaseDetails {
    id: number;
    rev: number;
    title: string;
    state?: string;
    priority?: number;
    assignedTo?: string;
    areaPath?: string;
    iterationPath?: string;
    automationStatus?: string;
    description?: string;
    steps: TestStep[];
    parameters: TestCaseParameters;
    /** Null when Azure DevOps refused the lookup (a suite in a project the user cannot read). */
    suites: TestCaseSuiteRef[] | null;
    url: string;
}
