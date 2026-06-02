import type { ScoredSurvival, SurvivalSignals } from "./types";

/**
 * PURE. A file is a death candidate iff it has zero recent churn, zero inbound
 * imports, and no test coverage. Reads no fs/git/clock.
 */
export function scoreSurvival(signals: SurvivalSignals): ScoredSurvival {
    const isCandidate = signals.churnCount === 0 && signals.inboundImports === 0 && signals.hasCoverage === false;

    return { ...signals, isCandidate };
}
