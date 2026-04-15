import { describe, expect, it } from "bun:test";
import { isLikelyDevProcess, parseLsofOutput, summarizeCommand } from "../lib/scanner";

describe("parseLsofOutput", () => {
    it("deduplicates by pid and keeps the highest-priority state", () => {
        const output = [
            "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
            "node 123 alice 21u IPv4 0t0 TCP *:3000 (ESTABLISHED)",
            "node 123 alice 22u IPv4 0t0 TCP *:3000 (LISTEN)",
            "bun 456 bob 12u IPv4 0t0 TCP *:3001 (LISTEN)",
        ].join("\n");

        const processes = parseLsofOutput(output, -1);

        expect(processes).toHaveLength(2);
        expect(processes[0]).toMatchObject({ pid: 123, state: "LISTEN" });
        expect(processes[1]).toMatchObject({ pid: 456, state: "LISTEN" });
    });
});

describe("summarizeCommand", () => {
    it("prefers meaningful script fragments over the executable name", () => {
        const summary = summarizeCommand("node /Users/test/app/server.js --port 3000", "node");

        expect(summary).toBe("server.js 3000");
    });

    it("falls back to the process name when nothing useful is present", () => {
        expect(summarizeCommand("node --watch --inspect", "node")).toBe("node");
    });
});

describe("isLikelyDevProcess", () => {
    it("recognizes common dev runtimes", () => {
        expect(isLikelyDevProcess("node", "node server.js")).toBeTrue();
        expect(isLikelyDevProcess("python3", "python3 manage.py runserver")).toBeTrue();
    });

    it("filters out common desktop apps", () => {
        expect(isLikelyDevProcess("Spotify Helper", "Spotify Helper")).toBeFalse();
    });
});
