import { describe, expect, it } from "bun:test";
import { inferAccountNameFromEmail, inferAccountNameFromLogin, parseConfigJson } from "@app/ai-proxy/lib/config";

describe("ai-proxy config", () => {
    it("infers account name from email local part", () => {
        expect(inferAccountNameFromEmail("alice@example.com")).toBe("alice");
    });

    it("infers account name from github login", () => {
        expect(inferAccountNameFromLogin("GenesisCz")).toBe("genesiscz");
    });

    it("parses config json with defaults", () => {
        const config = parseConfigJson(
            '{"accounts":[{"name":"genesiscz","provider":"grok-subscription","providerSlug":"grok","enabled":true}]}'
        );
        expect(config.listen.port).toBe(8317);
        expect(config.accounts[0]?.name).toBe("genesiscz");
    });

    it("parses nested githubCopilot account config", () => {
        const config = parseConfigJson(
            '{"accounts":[{"name":"genesiscz","provider":"github-copilot-subscription","providerSlug":"github-copilot","enabled":true,"githubCopilot":{"dataDir":"/tmp/copilot","type":"individual"}}]}'
        );

        expect(config.accounts[0]?.githubCopilot).toEqual({
            dataDir: "/tmp/copilot",
            type: "individual",
        });
    });
});
