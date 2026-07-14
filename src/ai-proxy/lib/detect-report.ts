import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import type { GithubCopilotTokenSource } from "@app/utils/ai/github-copilot/copilot-cli-auth";
import pc from "picocolors";

export interface DetectedAccountReport {
    account: AiProxyAccountConfig;
    providerTitle: string;
    detectedFrom: string;
    identity?: string;
    tier?: string;
    usage?: string;
    authRef?: string;
    suggestedModel?: string;
}

const LABEL_WIDTH = 10;

function padLabel(label: string): string {
    return pc.dim(label.padEnd(LABEL_WIDTH));
}

export function formatGithubCopilotTokenSource(source: GithubCopilotTokenSource): string {
    switch (source) {
        case "data-dir":
            return "ai-proxy token file";
        case "copilot-github-token-env":
            return "COPILOT_GITHUB_TOKEN";
        case "github-token-env":
            return "GITHUB_TOKEN";
        case "copilot-cli-keychain":
            return "Copilot CLI login (macOS Keychain)";
        case "copilot-cli-plaintext":
            return "Copilot CLI config";
        default: {
            const unreachable: never = source;
            return String(unreachable);
        }
    }
}

export function providerTitleFor(account: AiProxyAccountConfig): string {
    switch (account.provider) {
        case "grok-subscription":
            return "Grok";
        case "github-copilot-subscription":
            return "GitHub Copilot";
        case "xai-api-key":
            return "xAI API";
        default:
            return account.providerSlug;
    }
}

export function suggestedModelFor(account: AiProxyAccountConfig): string | undefined {
    switch (account.provider) {
        case "grok-subscription":
            return `${account.name}/grok/grok-composer-2.5-fast`;
        case "github-copilot-subscription":
            return `${account.name}/github-copilot/claude-sonnet-4`;
        case "xai-api-key":
            return `${account.name}/${account.providerSlug}/grok-4.5`;
        default:
            return undefined;
    }
}

function formatReportBlock(report: DetectedAccountReport): string {
    const lines: string[] = [pc.bold(pc.cyan(report.providerTitle))];

    lines.push(`  ${padLabel("Account")} ${report.account.name}`);

    if (report.identity) {
        lines.push(`  ${padLabel("Identity")} ${report.identity}`);
    }

    lines.push(`  ${padLabel("Detected")} ${report.detectedFrom}`);

    if (report.tier) {
        lines.push(`  ${padLabel("Plan")} ${report.tier}`);
    }

    if (report.usage) {
        lines.push(`  ${padLabel("Quota")} ${report.usage}`);
    }

    if (report.authRef) {
        lines.push(`  ${padLabel("Auth")} ${report.authRef}`);
    }

    if (report.suggestedModel) {
        lines.push(`  ${padLabel("Model")} ${report.suggestedModel}`);
    }

    return lines.join("\n");
}

export function formatDetectReportText(reports: DetectedAccountReport[]): string {
    if (reports.length === 0) {
        return "";
    }

    return reports.map(formatReportBlock).join("\n\n");
}
