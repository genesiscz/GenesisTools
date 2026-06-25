import { describe, expect, it } from "bun:test";
import type { DetectedAccountReport } from "@app/ai-proxy/lib/detect-report";
import { formatDetectReportText, formatGithubCopilotTokenSource } from "@app/ai-proxy/lib/detect-report";

function stripAnsi(text: string): string {
    const esc = String.fromCharCode(27);
    return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

describe("detect-report", () => {
    it("formats provider sections with indented account details", () => {
        const reports: DetectedAccountReport[] = [
            {
                account: {
                    name: "genesiscz",
                    provider: "grok-subscription",
                    providerSlug: "grok",
                    enabled: true,
                },
                providerTitle: "Grok",
                detectedFrom: "~/.grok/auth.json",
                identity: "genesiscz@example.com",
                tier: "SuperGrok Heavy",
                usage: "$10.00 / $1500.00 (0.7%)",
                authRef: "~/.grok/auth.json",
                suggestedModel: "genesiscz/grok/grok-composer-2.5-fast",
            },
            {
                account: {
                    name: "genesiscz",
                    provider: "github-copilot-subscription",
                    providerSlug: "github-copilot",
                    enabled: true,
                },
                providerTitle: "GitHub Copilot",
                detectedFrom: "Copilot CLI login (macOS Keychain)",
                identity: "genesiscz",
                tier: "business",
                usage: "Copilot chat quota: 0 remaining (100% left)",
                authRef: "~/.local/share/copilot-api/github_token",
                suggestedModel: "genesiscz/github-copilot/claude-sonnet-4",
            },
        ];

        const text = stripAnsi(formatDetectReportText(reports));

        expect(text).toContain("Grok");
        expect(text).toContain("Account    genesiscz");
        expect(text).toContain("Model      genesiscz/grok/grok-composer-2.5-fast");
        expect(text).toContain("GitHub Copilot");
        expect(text).toContain("Account    genesiscz");
        expect(text).toContain("Detected   Copilot CLI login (macOS Keychain)");
        expect(text.split("\n\n").length).toBe(2);
    });

    it("maps copilot token sources to readable labels", () => {
        expect(formatGithubCopilotTokenSource("copilot-cli-keychain")).toBe("Copilot CLI login (macOS Keychain)");
        expect(formatGithubCopilotTokenSource("data-dir")).toBe("ai-proxy token file");
    });
});
