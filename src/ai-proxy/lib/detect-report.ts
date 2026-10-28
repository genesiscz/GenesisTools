import { providerDefinition } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import type { GithubCopilotTokenSource } from "@genesiscz/utils/ai/github-copilot/copilot-cli-auth";
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

/** The vendor's name; a provider this build does not know shows its slug. */
export function providerTitleFor(account: AiProxyAccountConfig): string {
    return providerDefinition(account.provider)?.title ?? account.providerSlug;
}

export function suggestedModelFor(account: AiProxyAccountConfig): string | undefined {
    return providerDefinition(account.provider)?.suggestedModel(account);
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
