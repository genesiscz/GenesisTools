import { formatBytes } from "@app/doctor/lib/size";
import type { Action, Finding } from "@app/doctor/lib/types";
import * as p from "@app/utils/prompts/p";
import pc from "picocolors";

export interface SelectedAction {
    finding: Finding;
    action: Action;
}

function severityColor(severity: Finding["severity"]): (value: string) => string {
    if (severity === "safe") {
        return pc.green;
    }

    if (severity === "cautious") {
        return pc.yellow;
    }

    if (severity === "dangerous") {
        return pc.red;
    }

    return pc.gray;
}

function labelFor(finding: Finding): string {
    const color = severityColor(finding.severity);
    const bytes = finding.reclaimableBytes ? pc.dim(` - ${formatBytes(finding.reclaimableBytes)}`) : "";
    const detail = finding.detail ? pc.dim(` - ${finding.detail}`) : "";
    const tag = color(`[${finding.severity}]`);
    return `${tag} ${finding.title}${bytes}${detail}`;
}

async function pickAction(finding: Finding): Promise<Action | null> {
    if (finding.actions.length === 1) {
        return finding.actions[0] ?? null;
    }

    const actionId = await p.select({
        message: `Action for ${finding.title}`,
        options: finding.actions.map((action) => ({
            value: action.id,
            label: action.label,
        })),
    });

    return finding.actions.find((action) => action.id === actionId) ?? null;
}

export async function selectFindings(findings: Finding[]): Promise<Finding[]> {
    if (findings.length === 0) {
        return [];
    }

    const safeIds = findings.filter((finding) => finding.severity === "safe").map((finding) => finding.id);
    const pickableFindings = findings.filter((finding) => finding.severity !== "blocked");

    if (pickableFindings.length === 0) {
        p.log.info("All findings are on the safety blacklist. Nothing actionable.");

        for (const finding of findings) {
            p.log.warn(`${finding.title} - blocked: ${finding.blacklistReason ?? "no reason recorded"}`);
        }

        return [];
    }

    const picked = await p.multiselect({
        message: "Select findings to act on",
        options: pickableFindings.map((finding) => ({
            value: finding.id,
            label: labelFor(finding),
            hint: finding.actions.length === 1 ? finding.actions[0]?.label : undefined,
        })),
        initialValues: safeIds,
        required: false,
    });

    const pickedSet = new Set(picked);
    return pickableFindings.filter((finding) => pickedSet.has(finding.id));
}

export async function confirmActions(selected: Finding[]): Promise<SelectedAction[]> {
    const result: SelectedAction[] = [];

    for (const finding of selected) {
        if (finding.actions.length === 0) {
            continue;
        }

        const action = await pickAction(finding);
        if (!action) {
            continue;
        }

        if (action.confirm === "none") {
            result.push({ finding, action });
            continue;
        }

        if (action.confirm === "yesno") {
            const ok = await p.confirm({
                message: `${action.label} - ${finding.title}?`,
                danger: finding.severity === "dangerous",
            });

            if (ok) {
                result.push({ finding, action });
            }

            continue;
        }

        if (action.confirm === "typed") {
            const phrase = action.confirmPhrase ?? "DELETE";
            const ok = await p.typedConfirm({
                message: `${pc.red("[danger]")} ${action.label} - ${finding.title}`,
                phrase,
                caseSensitive: true,
            });

            if (ok) {
                result.push({ finding, action });
            }
        }
    }

    return result;
}
