// Default squash commit message: PR title plus " (#N)" as the subject, and the
// PR's commit subjects in original order as "* <subject>" bullets, one newline
// apart. Pure; the caller fetches the commits and decides whether to use it.

export interface PullCommitSubject {
    sha: string;
    /** First line of the commit message. */
    subject: string;
}

export interface SquashMessageInput {
    number: number;
    title: string;
    commits: PullCommitSubject[];
    /** Explicit --subject; wins over the generated one. */
    commitTitle?: string;
    /** Explicit --body; wins over the generated one. */
    commitMessage?: string;
}

export interface SquashMessage {
    title: string;
    body: string;
    /** True when the title came from the PR title, not from --subject. */
    titleGenerated: boolean;
    /** True when the body came from the commit list, not from --body. */
    bodyGenerated: boolean;
    /** Number of commit subjects folded into the generated body. */
    commitCount: number;
}

/** First line of a commit message, trimmed; never empty. */
export function commitSubjectOf(message: string): string {
    const first = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return first.length > 0 ? first : "(no subject)";
}

/** `title (#N)` unless the title already carries that exact suffix. */
export function defaultSquashTitle(title: string, number: number): string {
    const trimmed = title.trim();
    const suffix = `(#${number})`;

    if (trimmed.endsWith(suffix)) {
        return trimmed;
    }

    return `${trimmed} ${suffix}`;
}

/** One `* <subject>` bullet per commit, single newline between bullets, no blank lines. */
export function defaultSquashBody(commits: PullCommitSubject[]): string {
    return commits.map((c) => `* ${commitSubjectOf(c.subject)}`).join("\n");
}

export function buildSquashMessage(input: SquashMessageInput): SquashMessage {
    const title = input.commitTitle || defaultSquashTitle(input.title, input.number);
    const body = input.commitMessage ?? defaultSquashBody(input.commits);

    return {
        title,
        body,
        titleGenerated: !input.commitTitle,
        bodyGenerated: input.commitMessage === undefined,
        commitCount: input.commits.length,
    };
}

/** Lines the CLI prints so the user can inspect a generated message before trusting it. */
export function describeSquashMessage(message: SquashMessage): string[] {
    const lines: string[] = [];
    const titleSource = message.titleGenerated ? "generated from the PR title" : "from --subject";
    const bodySource = message.bodyGenerated
        ? `generated from ${message.commitCount} commit subject(s)`
        : "from --body";
    lines.push(`Squash commit message (subject ${titleSource}; body ${bodySource}):`);
    lines.push(`  ${message.title}`);

    if (message.body.length === 0) {
        lines.push("  (empty body)");
    } else {
        for (const line of message.body.split("\n")) {
            lines.push(`  ${line}`);
        }
    }

    return lines;
}
