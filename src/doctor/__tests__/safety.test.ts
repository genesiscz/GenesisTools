import { describe, expect, it } from "bun:test";
import {
    CACHE_BLACKLIST_GLOBS,
    classifyCachePath,
    classifyProcess,
    PROCESS_AUTO_RESPAWN,
    PROCESS_NEVER_KILL,
} from "@app/doctor/lib/safety";

describe("safety.classifyCachePath", () => {
    it("blocks JetBrains cache", () => {
        const result = classifyCachePath("~/Library/Caches/JetBrains/IntelliJIdea2024.3/caches");
        expect(result.severity).toBe("blocked");
        expect(result.reason).toContain("JetBrains");
    });

    it("blocks com.apple.iconservices", () => {
        const result = classifyCachePath("~/Library/Caches/com.apple.iconservices.store");
        expect(result.severity).toBe("blocked");
    });

    it("returns cautious for generic cache paths", () => {
        const result = classifyCachePath("~/Library/Caches/com.example.app");
        expect(result.severity).toBe("cautious");
        expect(result.reason).toBeUndefined();
    });
});

describe("safety.classifyProcess", () => {
    it("blocks kernel_task", () => {
        expect(classifyProcess("kernel_task").severity).toBe("blocked");
    });

    it("annotates Finder as auto-respawn", () => {
        const result = classifyProcess("Finder");
        expect(result.severity).toBe("cautious");
        expect(result.autoRespawn).toBe(true);
    });

    it("classifies unknown user process as cautious", () => {
        const result = classifyProcess("node");
        expect(result.severity).toBe("cautious");
        expect(result.autoRespawn).toBe(false);
    });
});

describe("safety constants", () => {
    it("PROCESS_NEVER_KILL includes critical daemons", () => {
        expect(PROCESS_NEVER_KILL.has("launchd")).toBe(true);
        expect(PROCESS_NEVER_KILL.has("WindowServer")).toBe(true);
    });

    it("PROCESS_AUTO_RESPAWN includes Finder and Dock", () => {
        expect(PROCESS_AUTO_RESPAWN.has("Finder")).toBe(true);
        expect(PROCESS_AUTO_RESPAWN.has("Dock")).toBe(true);
    });

    it("CACHE_BLACKLIST_GLOBS covers JetBrains family", () => {
        const hasJetBrains = CACHE_BLACKLIST_GLOBS.some((glob) => glob.includes("JetBrains"));
        expect(hasJetBrains).toBe(true);
    });
});
