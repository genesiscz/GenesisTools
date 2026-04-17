import { describe, expect, it } from "bun:test";
import { parseBunList, parseNpmJson, parseYarnJson, reinstallCommand } from "@app/doctor/lib/global-packages";
import { SafeJSON } from "@app/utils/json";

describe("parseBunList", () => {
    it("parses bun pm ls -g output", () => {
        const raw = [
            "/Users/me/.bun/install/global node_modules (13)",
            "├── @typescript/native-preview@0.0.1",
            "├── prettier@3.4.2",
            "└── tsx@4.19.2",
        ].join("\n");

        const pkgs = parseBunList(raw);
        expect(pkgs).toContain("@typescript/native-preview@0.0.1");
        expect(pkgs).toContain("tsx@4.19.2");
        expect(pkgs).toHaveLength(3);
    });
});

describe("parseNpmJson", () => {
    it("parses npm ls --json output", () => {
        const raw = SafeJSON.stringify({
            dependencies: {
                typescript: { version: "5.4.0" },
                eslint: { version: "8.0.0" },
            },
        });

        const pkgs = parseNpmJson(raw);
        expect(pkgs).toEqual(["typescript@5.4.0", "eslint@8.0.0"]);
    });

    it("handles empty json", () => {
        expect(parseNpmJson("")).toEqual([]);
    });
});

describe("parseYarnJson", () => {
    it("parses yarn global list output line by line", () => {
        const raw = [
            '{"type":"info","data":"\\"typescript@5.4.0\\""}',
            '{"type":"info","data":"\\"eslint@8.0.0\\""}',
        ].join("\n");

        const pkgs = parseYarnJson(raw);
        expect(pkgs).toContain("typescript@5.4.0");
        expect(pkgs).toContain("eslint@8.0.0");
    });
});

describe("reinstallCommand", () => {
    it("uses bun add for global bun packages", () => {
        expect(reinstallCommand("bun", ["tsx@4.19.2"])).toEqual({
            cmd: "bun",
            args: ["add", "-g", "tsx@4.19.2"],
        });
    });
});
