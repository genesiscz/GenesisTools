import { adoOrganizationOf } from "@app/azure-devops/lib/comments";
import type { AzureConfig } from "@app/azure-devops/types";
import { buildUrl } from "@genesiscz/utils/url";

/** A plan, and optionally one of its suites, from a pasted Test Plans URL or from ids. */
export interface PlanRef {
    planId: number;
    suiteId?: number;
}

export interface SuiteRef {
    planId: number;
    suiteId: number;
}

function positiveInt(value: string | null | undefined, what: string): number {
    const trimmed = value?.trim() ?? "";

    if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
        throw new Error(`Expected a ${what} id (a positive whole number), got '${value ?? ""}'`);
    }

    return Number(trimmed);
}

/**
 * `12`, or a web URL such as `https://dev.azure.com/org/project/_testPlans/define?planId=12&suiteId=13`
 * (also `execute` and `charts`). A URL of another organization than the configured one is refused.
 */
export function parsePlanRef(input: string, configuredOrg?: string): PlanRef {
    const trimmed = input.trim();

    if (!URL.canParse(trimmed)) {
        return { planId: positiveInt(trimmed, "test plan") };
    }

    const url = new URL(trimmed);
    const inputOrg = adoOrganizationOf(trimmed);
    const targetOrg = configuredOrg ? adoOrganizationOf(configuredOrg) : null;

    if (inputOrg !== null && targetOrg !== null && inputOrg !== targetOrg) {
        throw new Error(`The URL is in organization '${inputOrg}', but the configured organization is '${targetOrg}'`);
    }

    const planId = url.searchParams.get("planId");

    if (!planId) {
        throw new Error(`The URL has no planId: ${trimmed}`);
    }

    const suiteId = url.searchParams.get("suiteId");
    return { planId: positiveInt(planId, "test plan"), suiteId: suiteId ? positiveInt(suiteId, "suite") : undefined };
}

/** A suite from a URL that names both ids, or from a plan reference plus a suite id. */
export function parseSuiteRef(input: string, suiteArg: string | undefined, configuredOrg?: string): SuiteRef {
    const plan = parsePlanRef(input, configuredOrg);
    const suiteId = suiteArg !== undefined ? positiveInt(suiteArg, "suite") : plan.suiteId;

    if (suiteId === undefined) {
        throw new Error("Name the suite: a URL with suiteId, or the plan id followed by the suite id");
    }

    return { planId: plan.planId, suiteId };
}

export type TestPlansView = "define" | "execute";

export function testPlansWebUrl(config: AzureConfig, ref: PlanRef, view: TestPlansView = "define"): string {
    return buildUrl({
        base: config.org,
        segments: [encodeURIComponent(config.project), "_testPlans", view],
        queryParams: {
            planId: String(ref.planId),
            ...(ref.suiteId === undefined ? {} : { suiteId: String(ref.suiteId) }),
        },
    });
}

/** Ids from `1,2 3` or repeated arguments. */
export function parseIdList(values: readonly string[], what: string): number[] {
    const ids = values.flatMap((value) => value.split(/[\s,]+/)).filter(Boolean);

    if (ids.length === 0) {
        throw new Error(`Name at least one ${what} id`);
    }

    return [...new Set(ids.map((id) => positiveInt(id, what)))];
}
