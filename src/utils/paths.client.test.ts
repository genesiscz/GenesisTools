import { describe, expect, it } from "bun:test";
import {
    collapsePathForDisplay,
    longestCommonPathPrefix,
    resolveDirPathDisplayPrefix,
    shortenPathWithPrefix,
    toPosixPath,
} from "./paths.client";

describe("paths.client", () => {
    it("normalizes backslashes", () => {
        expect(toPosixPath("a\\b\\c")).toBe("a/b/c");
    });

    it("collapses mac home paths to tilde", () => {
        expect(collapsePathForDisplay("/Users/dev/Projects/app")).toBe("~/Projects/app");
    });

    it("leaves non-home absolute paths unchanged", () => {
        expect(collapsePathForDisplay("/var/log/syslog")).toBe("/var/log/syslog");
    });

    it("finds longest common path prefix across collapsed home paths", () => {
        const paths = [
            "/Users/Martin/Tresors/Projects/widgets/web-app/mobile-app",
            "/Users/Martin/Tresors/Projects/GenesisTools",
            "/Users/Martin/Tresors/Projects/Other/app",
        ];

        expect(longestCommonPathPrefix(paths)).toBe("~/Tresors/Projects");
    });

    it("returns empty prefix when paths do not share a directory", () => {
        expect(longestCommonPathPrefix(["~/Projects/a", "/var/log"])).toBe("");
    });

    it("returns empty prefix for a single unique path", () => {
        expect(longestCommonPathPrefix(["~/Projects/app"])).toBe("");
    });

    it("does not treat home alone as a shared prefix", () => {
        expect(longestCommonPathPrefix(["~/Projects/a", "~/Other/b"])).toBe("");
    });

    it("shortens paths using a shared prefix", () => {
        const prefix = "~/Tresors/Projects";

        expect(shortenPathWithPrefix("~/Tresors/Projects/widgets/web-app/mobile-app", prefix)).toBe(
            "widgets/web-app/mobile-app"
        );
        expect(shortenPathWithPrefix("~/Tresors/Projects/GenesisTools", prefix)).toBe("GenesisTools");
        expect(shortenPathWithPrefix("~/Tresors/Projects", prefix)).toBe(".");
    });

    it("keeps worktree folders visible when siblings share a repo", () => {
        const paths = [
            "~/Tresors/Projects/widgets/web-app/.claude/worktrees/wt-a",
            "~/Tresors/Projects/widgets/web-app/.claude/worktrees/wt-b",
        ];
        const prefix = resolveDirPathDisplayPrefix(paths);

        expect(prefix).toBe("~/Tresors/Projects");
        expect(shortenPathWithPrefix(paths[0], prefix)).toBe("widgets/web-app/.claude/worktrees/wt-a");
        expect(shortenPathWithPrefix(paths[1], prefix)).toBe("widgets/web-app/.claude/worktrees/wt-b");
    });

    it("supports .worktrees/ sibling paths", () => {
        const paths = ["~/Projects/app/.worktrees/feature-a", "~/Projects/app/.worktrees/feature-b"];
        const prefix = resolveDirPathDisplayPrefix(paths);

        expect(prefix).toBe("~/Projects");
        expect(shortenPathWithPrefix(paths[0], prefix)).toBe("app/.worktrees/feature-a");
    });
});
