import { describe, expect, test } from "bun:test";
import { evaluateSummary, parseXaiStatusHtml, summaryUrl, worstStatus } from "./statuspage";

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

    test("worstStatus ranks down over degraded over up", () => {
        expect(worstStatus(["up", "degraded", "down"])).toBe("down");
        expect(worstStatus(["up", "unknown"])).toBe("up");
        expect(worstStatus([])).toBe("up");
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

    test("an all-available page is operational", () => {
        const summary = parseXaiStatusHtml("<p>Services</p><p>Docs</p><p>available</p><p>Models</p>");

        expect(summary.components).toEqual([{ name: "Docs", status: "operational" }]);
        expect(summary.status).toEqual({ indicator: "none", description: "All Systems Operational" });
    });
});
