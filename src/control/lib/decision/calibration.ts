import type { DecisionPolicy } from "./decisions";

// Conservative offline alternatives; the first policy is the unchanged runtime default.
export const calibrationPolicies = [
    { minProbability: 0.8, minMargin: 0.15, minConfidence: 0.7 },
    { minProbability: 0.85, minMargin: 0.2, minConfidence: 0.75 },
    { minProbability: 0.9, minMargin: 0.25, minConfidence: 0.8 },
    { minProbability: 0.95, minMargin: 0.3, minConfidence: 0.85 },
] satisfies DecisionPolicy[];

export interface CalibrationRow {
    fixture: string;
    split: string;
    mode: string;
    policy: number;
    expected: number | null;
    selected: number | null;
    status: string;
}

export function summarizeCalibration(rows: CalibrationRow[]) {
    const cases = rows.length;
    const wrongActions = rows.filter((row) => row.selected !== null && row.selected !== row.expected).length;
    const correct = rows.filter((row) => row.selected === row.expected).length;
    const abstentions = rows.filter((row) => row.selected === null).length;
    return {
        cases,
        correct,
        correctActions: rows.filter((row) => row.selected !== null && row.selected === row.expected).length,
        wrongActions,
        abstentions,
        hostHandoffs: rows.filter((row) => row.status === "escalated").length,
        accuracy: cases ? correct / cases : null,
        wrongActionRate: cases ? wrongActions / cases : null,
        abstentionRate: cases ? abstentions / cases : null,
    };
}

export function calibrationReport(rows: CalibrationRow[]) {
    const curves = ["jev", "auto"].flatMap((mode) =>
        calibrationPolicies.map((policy, index) => ({
            mode,
            policy,
            policyIndex: index,
            development: summarizeCalibration(
                rows.filter((row) => row.mode === mode && row.policy === index && row.split === "development")
            ),
            heldOut: summarizeCalibration(
                rows.filter((row) => row.mode === mode && row.policy === index && row.split === "held-out")
            ),
        }))
    );
    return {
        curves,
        selected: ["jev", "auto"].map((mode) => {
            const training = curves.filter((row) => row.mode === mode && row.development.cases > 0);
            // Held-out labels never participate in selection. Stable ties preserve the default.
            training.sort(
                (a, b) =>
                    a.development.wrongActions - b.development.wrongActions ||
                    b.development.correct - a.development.correct ||
                    a.policyIndex - b.policyIndex
            );
            return training[0] ?? null;
        }),
        rows,
        runtimePolicyChanged: false,
        selectionRule:
            "Development only: fewest wrong choices, then most correct outcomes; ties retain earlier policy.",
        note: "Synthetic calibration only. Policies replay identical responses with zero additional paid calls. Request, latency and cost totals belong to collection, not each curve. Handoffs are not measured assistant turns. No desktop actions or runtime policy changes.",
    };
}
