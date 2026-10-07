import { describe, expect, it } from "bun:test";
import axios from "axios";
import type { JenkinsBackend } from "./client";
import {
    getDownstreamJobs,
    getJobNameFromPath,
    getJobType,
    isMasterBuild,
    type JobContext,
    subJobsFolder,
} from "./jobs";
import { findTriggeredBuilds, trackPipeline } from "./track-pipeline";
import { analyzeUrl, parseBuildUrl } from "./url-analyzer";
import { findNode, formatSummary, lastMatch, summarize } from "./wfapi";

const BASE = "https://jenkins.example.invalid";
const APP = "job/Acme/job/web/job/FE/job/app-build";
const ANDROID = "job/Acme/job/web/job/FE/job/android-app";
const IOS = "job/Acme/job/web/job/FE/job/ios-app";

const CTX: JobContext = {
    catalog: [{ name: "app-build", path: APP, type: "mobile", automatic: true, byTag: false }],
    rules: {
        masters: ["app-build"],
        downstream: { "app-build": [ANDROID, IOS] },
        typeHints: [
            { type: "mobile", match: ["android", "ios"] },
            { type: "deploy", match: ["deploy"] },
        ],
    },
};

describe("jobs", () => {
    it("names the job from its path", () => {
        expect(getJobNameFromPath(APP)).toBe("app-build");
        expect(getJobNameFromPath("job/solo")).toBe("solo");
    });

    it("knows nothing without a catalog or rules", () => {
        expect(isMasterBuild(APP)).toBe(false);
        expect(getDownstreamJobs(APP)).toEqual([]);
        expect(getJobType(APP)).toBe("unknown");
    });

    it("reads masters, downstream jobs and type hints from the rules", () => {
        expect(isMasterBuild(APP, CTX)).toBe(true);
        expect(getDownstreamJobs(APP, CTX)).toEqual([ANDROID, IOS]);
        expect(getJobType(APP, CTX)).toBe("mobile");
        expect(getJobType("job/Acme/job/site-deploy", CTX)).toBe("deploy");
        expect(getJobType("job/Acme/job/docs", CTX)).toBe("unknown");
    });

    it("finds the folder of an orchestrator's sub-jobs", () => {
        expect(subJobsFolder("job/Acme/job/FE/job/app-multibranch/job/MR-1")).toBe("job/Acme/job/FE");
    });
});

describe("parseBuildUrl", () => {
    it("parses a console URL and a pipeline overview URL", () => {
        expect(parseBuildUrl(`${BASE}/${APP}/12/console`)).toEqual({
            jobPath: APP,
            buildNumber: 12,
            isConsole: true,
            isPipelineOverview: false,
        });
        expect(parseBuildUrl(`${BASE}/${APP}/12/pipeline-overview/?selected-node=4`)?.isPipelineOverview).toBe(true);
    });

    it("accepts a job path and refuses text that names no job", () => {
        expect(parseBuildUrl(APP)?.jobPath).toBe(APP);
        expect(parseBuildUrl("not a url")).toBeNull();
        expect(parseBuildUrl(`${BASE}/manage/`)).toBeNull();
    });
});

describe("analyzeUrl", () => {
    it("suggests a rebuild and the logs for a failed build", () => {
        const analysis = analyzeUrl(`${BASE}/job/Acme/job/site/7/`, {
            number: 7,
            result: "FAILURE",
            building: false,
            duration: 1000,
            timestamp: 0,
        });

        expect(analysis?.suggestedActions.map((a) => a.id)).toEqual(["rebuild", "search-logs", "view-logs"]);
        expect(analysis?.suggestedActions[0].command).toContain("jenkins rebuild job/Acme/job/site 7");
    });

    it("names the downstream jobs of a master build in the context", () => {
        const analysis = analyzeUrl(`${BASE}/${APP}/3/`, null, CTX);

        expect(analysis?.jobType).toBe("mobile");
        expect(analysis?.context).toContain("triggers android-app + ios-app");
        expect(analysis?.suggestedActions[0].id).toBe("track-pipeline");
    });
});

describe("findTriggeredBuilds", () => {
    it("maps trigger lines onto the downstream job paths", () => {
        const log = "Triggering android-app #4567\nsomething else\nTriggering ios-app #8901\nTriggering unknown #1";

        expect(findTriggeredBuilds(log, [ANDROID, IOS])).toEqual([
            { jobPath: ANDROID, buildNumber: 4567 },
            { jobPath: IOS, buildNumber: 8901 },
        ]);
    });
});

describe("trackPipeline", () => {
    it("waits for the master, finds the downstream builds in its log and reports all passed", async () => {
        const builds: Record<string, { number: number; result?: string; building: boolean }[]> = {
            [`${APP}/3`]: [
                { number: 3, building: true },
                { number: 3, result: "SUCCESS", building: false },
            ],
            [`${ANDROID}/40`]: [{ number: 40, result: "SUCCESS", building: false }],
            [`${IOS}/50`]: [{ number: 50, result: "SUCCESS", building: false }],
        };
        const get = async <T>(path: string): Promise<T | null> => {
            const key = path.split("/api/json")[0];
            const queue = builds[key];

            if (!queue) {
                return null;
            }

            const next = queue.length > 1 ? queue.shift() : queue[0];
            return { duration: 1, timestamp: 0, ...next } as T;
        };
        const backend: JenkinsBackend = {
            baseUrl: BASE,
            client: axios.create(),
            fullUrl: (p) => `${BASE}/${p}`,
            api: async <T>(p: string) => (await get<T>(p)) as T,
            apiOrNull: get,
            apiTextOrNull: async () => "Triggering android-app #40\nTriggering ios-app #50",
            post: async () => ({ status: 500 }),
        };
        const notes: string[] = [];
        const result = await trackPipeline(backend, APP, 3, {
            ...CTX,
            sleep: async () => {},
            notify: async (m) => {
                notes.push(m);
            },
        });

        expect(result.allPassed).toBe(true);
        expect(result.master.status).toBe("SUCCESS");
        expect(result.downstream.map((d) => `${d.jobName} #${d.buildNumber}`)).toEqual([
            "android-app #40",
            "ios-app #50",
        ]);
        expect(notes).toEqual(["app-build #3 pipeline complete - android-app SUCCESS, ios-app SUCCESS"]);
    });
});

describe("wfapi helpers", () => {
    it("finds a flow node by its step description", () => {
        const stages = [
            {
                id: "1",
                name: "Install",
                status: "SUCCESS" as const,
                stageFlowNodes: [{ id: "2", name: "sh", status: "SUCCESS" as const, parameterDescription: "npm ci" }],
            },
        ];

        expect(findNode(stages, ["npm ci"])?.id).toBe("2");
        expect(findNode(stages, ["make"])).toBeUndefined();
    });

    it("takes the last match of a global regex", () => {
        expect(lastMatch("took 1s\ntook 2s", /took (\d)s/g)?.[1]).toBe("2");
        expect(lastMatch("nothing", /took (\d)s/g)).toBeNull();
    });

    it("summarizes a column and skips the gaps", () => {
        expect(summarize([4, null, 2, 6])).toEqual({ mean: 4, median: 4, min: 2, max: 6, n: 3 });
        expect(summarize([null])).toBeNull();
        expect(formatSummary("restore", [])).toBe("restore   (no data)");
    });
});
