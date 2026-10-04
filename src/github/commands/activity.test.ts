import { describe, expect, it } from "bun:test";
import type { GitHubEvent } from "@genesiscz/utils/github/types";
import { buildActivityItems } from "./activity";

function pushEvent(overrides: {
    id: string;
    createdAt: string;
    ref?: string;
    size?: number;
    commits?: Array<{ message: string }>;
}): GitHubEvent {
    return {
        id: overrides.id,
        type: "PushEvent",
        actor: { login: "arwen96", display_login: "arwen96" },
        repo: { name: "arwen96/Kalendora" },
        payload: {
            ref: overrides.ref ?? "refs/heads/main",
            ...(overrides.size !== undefined ? { size: overrides.size } : {}),
            ...(overrides.commits !== undefined ? { commits: overrides.commits } : {}),
        },
        created_at: overrides.createdAt,
        public: true,
    };
}

describe("buildActivityItems", () => {
    // Regression test: #453.6 — the GitHub Events API omits `payload.size` / `payload.commits`
    // for some PushEvents, and `commits.length` then fell back to 0, printing "Pushed 0
    // commit(s) to main" for a push that plainly had commits in it.
    it("a PushEvent with neither size nor commits summarizes without a bogus commit count", () => {
        const [item] = buildActivityItems([pushEvent({ id: "1", createdAt: "2026-10-03T21:35:57Z" })]);

        expect(item?.summary).toBe("Pushed to main");
        expect(item?.summary).not.toContain("0 commit");
    });

    // NEGATIVE CONTROL: a real commit count must still show, not just always say "Pushed to".
    it("a PushEvent carrying a real size still shows the commit count", () => {
        const [item] = buildActivityItems([pushEvent({ id: "1", createdAt: "2026-10-03T21:35:57Z", size: 3 })]);

        expect(item?.summary).toBe("Pushed 3 commit(s) to main");
    });

    // Regression test: #453.6 — row 12 (10/1 3:09:46 PM) sat between two 10/3 rows: the feed
    // was returned in roughly-reverse-chronological page order, not strictly sorted.
    it("orders activity items newest first regardless of the order events were fetched in", () => {
        const items = buildActivityItems([
            pushEvent({ id: "middle", createdAt: "2026-10-02T22:17:35Z" }),
            pushEvent({ id: "oldest", createdAt: "2026-10-01T15:09:46Z" }),
            pushEvent({ id: "newest", createdAt: "2026-10-03T21:31:40Z" }),
        ]);

        expect(items.map((item) => item.id)).toEqual(["newest", "middle", "oldest"]);
    });
});
