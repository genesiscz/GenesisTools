import { describe, expect, it } from "bun:test";
import {
    type BlueOceanNode,
    blueOceanNodesUrls,
    buildContextMap,
    contextFromBlueOcean,
    dedupeConsecutive,
} from "./blue-ocean";

describe("blueOceanNodesUrls", () => {
    it("prefers multibranch branch URL then full pipeline fallback", () => {
        const urls = blueOceanNodesUrls("job/Acme/job/web/job/FE/job/web-app-multibranch-build/job/develop", "7180");
        expect(urls).toHaveLength(2);
        expect(urls[0]).toContain("/pipelines/Acme/pipelines/web/pipelines/FE/pipelines/web-app-multibranch-build/");
        expect(urls[0]).toContain("/branches/develop/runs/7180/nodes/");
        expect(urls[1]).toContain("/pipelines/develop/runs/7180/nodes/");
        expect(urls[1]).not.toContain("/branches/");
    });

    it("percent-encodes branch segments (Jenkins stores feature/foo as one segment)", () => {
        // Classic URL already has one path segment for the branch; % must be re-encoded for Blue Ocean.
        const urls = blueOceanNodesUrls("job/pipe/job/feature%2Ffoo", "3");
        expect(urls[0]).toContain("/branches/feature%252Ffoo/");
    });
});

describe("dedupeConsecutive", () => {
    it("collapses PARALLEL+STAGE duplicate names", () => {
        expect(dedupeConsecutive(["Build affected apps", "web-app", "web-app", "Tests"])).toEqual([
            "Build affected apps",
            "web-app",
            "Tests",
        ]);
    });
});

describe("contextFromBlueOcean", () => {
    const nodes: BlueOceanNode[] = [
        { id: "12", displayName: "Clone", type: "STAGE", firstParent: null },
        { id: "58", displayName: "Repo QA", type: "STAGE", firstParent: "12" },
        { id: "62", displayName: "Type check", type: "PARALLEL", firstParent: "58" },
        { id: "75", displayName: "Build affected apps", type: "STAGE", firstParent: null },
        { id: "82", displayName: "web-app", type: "PARALLEL", firstParent: "75" },
        { id: "91", displayName: "web-app", type: "STAGE", firstParent: "82" },
        { id: "110", displayName: "Tests", type: "STAGE", firstParent: "91" },
        { id: "166", displayName: "Build", type: "STAGE", firstParent: "110" },
        { id: "499", displayName: "SonarQube", type: "STAGE", firstParent: "480" },
        { id: "480", displayName: "deploy", type: "STAGE", firstParent: "346" },
        { id: "346", displayName: "Build image", type: "STAGE", firstParent: "166" },
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    it("labels Tests with web-app context", () => {
        const ctx = contextFromBlueOcean("110", byId)!;
        expect(ctx.context).toBe("web-app");
        expect(ctx.label).toBe("web-app · Tests");
        expect(ctx.path).toEqual(["Build affected apps", "web-app", "Tests"]);
    });

    it("labels nested Build under web-app", () => {
        const ctx = contextFromBlueOcean("166", byId)!;
        expect(ctx.context).toBe("web-app");
        expect(ctx.label).toBe("web-app · Build");
    });

    it("labels SonarQube with web-app (not deploy)", () => {
        const ctx = contextFromBlueOcean("499", byId)!;
        expect(ctx.context).toBe("web-app");
        expect(ctx.label).toBe("web-app · SonarQube");
        expect(ctx.path).toContain("web-app");
        expect(ctx.path[ctx.path.length - 1]).toBe("SonarQube");
    });

    it("labels parallel QA under Repo QA", () => {
        const ctx = contextFromBlueOcean("62", byId)!;
        expect(ctx.context).toBe("Repo QA");
        expect(ctx.label).toBe("Repo QA · Type check");
    });

    it("keeps top-level Clone plain", () => {
        const ctx = contextFromBlueOcean("12", byId)!;
        expect(ctx.context).toBeUndefined();
        expect(ctx.label).toBe("Clone");
        expect(ctx.path).toEqual(["Clone"]);
    });

    it("keeps web-app shell label plain (no web-app · web-app)", () => {
        const ctx = contextFromBlueOcean("91", byId)!;
        expect(ctx.label).toBe("web-app");
    });
});

describe("buildContextMap", () => {
    it("indexes every node id", () => {
        const map = buildContextMap([
            { id: "1", displayName: "A", type: "STAGE", firstParent: null },
            { id: "2", displayName: "B", type: "STAGE", firstParent: "1" },
        ]);
        expect(map.get("2")?.label).toBe("A · B");
    });
});
