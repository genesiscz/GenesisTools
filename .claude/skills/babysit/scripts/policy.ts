/** One policy for generated worker briefs, judging and reply disposition. Dedicated user reviews are fixed in full. */
export function roundPolicy(options: { round: number; changedFiles: number; dedicatedReview?: boolean }) {
    const { round, changedFiles, dedicatedReview = false } = options;
    if (!Number.isSafeInteger(round) || round < 1 || !Number.isSafeInteger(changedFiles) || changedFiles < 0) {
        throw new Error("round and changed-file count must be finite integers (round >= 1, files >= 0)");
    }
    const throughRound = changedFiles > 100 ? 3 : 2;
    const fixAll = dedicatedReview || round <= throughRound;
    const text = [
        `Round ${round} (${changedFiles} changed files${dedicatedReview ? ", dedicated user review" : ""}): ` +
            (fixAll ? "fix EVERY valid finding, critical, high, medium and low." : "fix Critical and High findings."),
        "A valid security finding is always fixed, at any severity and in any round; use the reviewer's Security category.",
        fixAll
            ? "Fix every valid finding in this PR, including every file it needs; no deferral is accepted."
            : 'Other valid Medium/Low findings get an explained reply and stay OPEN. Use verdict "belongs-elsewhere" for the reply transport and explain the policy deferral; integrate posts them with --no-resolve.',
        "A rejection or no-change needs a cited file:line proving the finding wrong.",
    ].join(" ");
    return { fixAll, throughRound, text };
}

export function shouldFixFinding(policy: { fixAll: boolean }, severity: string, security = false): boolean {
    return policy.fixAll || security || /^(critical|high)$/i.test(severity);
}

/** Deferred replies are never included in the batch that resolves threads, regardless of reviewer. */
export function isDeferredReply(item: { verdict?: unknown; deferred?: unknown }): boolean {
    return item.deferred === true || item.verdict === "deferred" || item.verdict === "belongs-elsewhere";
}
