import { describe, expect, test } from "bun:test";
import {
    checkStatuspage,
    evaluateSummary,
    listStatuspageComponents,
    parseXaiStatusHtml,
    summaryUrl,
    worstStatus,
} from "./statuspage";

const SUMMARY = {
    page: { name: "Claude" },
    status: { indicator: "minor", description: "Minor Service Outage" },
    components: [
        { name: "claude.ai", status: "partial_outage" },
        { name: "Claude Console (platform.claude.com)", status: "operational" },
        { name: "Claude API (api.anthropic.com)", status: "operational" },
        { name: "Group", status: "partial_outage", group: true },
    ],
};

describe("statuspage", () => {
    test("summaryUrl appends the v2 summary path once", () => {
        expect(summaryUrl("https://status.claude.com/")).toBe("https://status.claude.com/api/v2/summary.json");
    });

    test("worstStatus ranks down over degraded over unknown over up", () => {
        expect(worstStatus(["up", "degraded", "down"])).toBe("down");
        expect(worstStatus(["up", "unknown"])).toBe("unknown");
        expect(worstStatus(["unknown", "degraded"])).toBe("degraded");
        expect(worstStatus([])).toBe("up");
    });

    test("a component state the table does not know reads as unknown, never as up", () => {
        // A self-hosted page with its own vocabulary, or a new Atlassian /
        // incident.io state. Mapping it to "up" rendered a real outage green.
        const result = evaluateSummary(
            { status: { indicator: "none" }, components: [{ name: "Claude API", status: "catastrophe" }] },
            ["claude api"]
        );

        expect(result.status).toBe("unknown");
        expect(result.affected.map((c) => c.name)).toEqual(["Claude API"]);
        expect(result.detail).toContain("Claude API: catastrophe");
    });

    test("without a filter the page indicator and affected components both count", () => {
        const result = evaluateSummary(SUMMARY, undefined);

        expect(result.status).toBe("degraded");
        expect(result.affected.map((c) => c.name)).toEqual(["claude.ai"]);
        expect(result.detail).toContain("Minor Service Outage");
        expect(result.detail).toContain("claude.ai: partial outage");
    });

    test("a component filter ignores unrelated outages", () => {
        const result = evaluateSummary(SUMMARY, ["Claude API"]);

        expect(result.status).toBe("up");
        expect(result.matched).toBe(1);
        expect(result.detail).toBe("1 matching component operational");
    });

    test("a major outage on a filtered component reads as down", () => {
        const result = evaluateSummary({ ...SUMMARY, components: [{ name: "Claude API", status: "major_outage" }] }, [
            "claude api",
        ]);

        expect(result.status).toBe("down");
    });

    test("major page indicator with no component detail is down", () => {
        expect(evaluateSummary({ status: { indicator: "major" }, components: [] }, undefined).status).toBe("down");
    });

    test("groups never count as components", () => {
        expect(
            evaluateSummary({ status: { indicator: "none" }, components: SUMMARY.components }, ["Group"]).matched
        ).toBe(0);
    });
});

describe("parseXaiStatusHtml", () => {
    const HTML = `<html><body><script>ignored|Services|x</script>
        <h2>Service Status</h2><div>Models outage</div><div>Grok (iOS)</div>
        <h2>Services</h2>
        <div><span>Grok (iOS)</span><span>outage</span></div>
        <div><span>Single Sign-On</span><span>available</span></div>
        <div><span>API (eu-west-1.api.x.ai)</span><span>degraded</span></div>
        <h3>Models</h3><p>Try Grok on</p>
    </body></html>`;

    test("reads the Services name/state pairs into Statuspage components", () => {
        const summary = parseXaiStatusHtml(HTML);

        expect(summary.components).toEqual([
            { name: "Grok (iOS)", status: "major_outage" },
            { name: "Single Sign-On", status: "operational" },
            { name: "API (eu-west-1.api.x.ai)", status: "degraded_performance" },
        ]);
        expect(summary.status?.indicator).toBe("major");
        expect(evaluateSummary(summary, ["API ("]).status).toBe("degraded");
        expect(evaluateSummary(summary, undefined).status).toBe("down");
    });

    test("a foreign token mid-list fails closed instead of reporting a partial page", () => {
        const html =
            "<p>Services</p><p>Grok (iOS)</p><p>available</p><p>Some new widget</p><p>Grok (Web)</p><p>outage</p>";
        const summary = parseXaiStatusHtml(html);

        expect(summary.components).toEqual([]);
        expect(() => evaluateSummary(summary, undefined)).not.toThrow();
    });

    test("an all-available page is operational", () => {
        const summary = parseXaiStatusHtml("<p>Services</p><p>Docs</p><p>available</p><p>Models</p>");

        expect(summary.components).toEqual([{ name: "Docs", status: "operational" }]);
        expect(summary.status).toEqual({ indicator: "none", description: "All Systems Operational" });
    });
});

describe("checkStatuspage summary shape", () => {
    async function withJsonBody<T>(payload: string, run: () => Promise<T>): Promise<T> {
        const realFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(
            async () => new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } }),
            { preconnect: realFetch.preconnect }
        );

        try {
            return await run();
        } finally {
            globalThis.fetch = realFetch;
        }
    }

    test("a page answering null is a check result, not a crash", async () => {
        // `as StatuspageSummary` accepted null, and evaluateSummary then died on
        // `summary.components ?? []` -> "Cannot read properties of null".
        const result = await withJsonBody("null", () =>
            checkStatuspage({ target: "https://status.a.dev", config: {}, timeoutMs: 1_000 })
        );

        expect(result.status).toBe("unknown");
        expect(result.detail).toContain("did not answer");
    });

    test("a page answering an array is a check result too", async () => {
        const result = await withJsonBody("[]", () =>
            checkStatuspage({ target: "https://status.a.dev", config: {}, timeoutMs: 1_000 })
        );

        expect(result.status).toBe("unknown");
    });

    test("a components field that is not a list is refused", async () => {
        const result = await withJsonBody(`{"components":"all good"}`, () =>
            checkStatuspage({ target: "https://status.a.dev", config: {}, timeoutMs: 1_000 })
        );

        expect(result.status).toBe("unknown");
    });

    test("the component picker rejects the same shape instead of leaking a 500", async () => {
        const promise = withJsonBody("null", () => listStatuspageComponents("https://status.a.dev", 1_000));

        await expect(promise).rejects.toThrow("did not answer");
    });

    test("a well-formed summary still parses", async () => {
        const result = await withJsonBody(
            `{"page":{"name":"A"},"status":{"indicator":"none","description":"All Systems Operational"},"components":[{"name":"API","status":"operational"}]}`,
            () => checkStatuspage({ target: "https://status.a.dev", config: {}, timeoutMs: 1_000 })
        );

        expect(result.status).toBe("up");
        expect(result.detail).toBe("All Systems Operational");
    });
});
