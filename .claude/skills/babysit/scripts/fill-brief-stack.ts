export interface StackPr {
    number: number;
    headRefName: string;
    baseRefName: string;
}

export function formatStack({
    pr,
    openPrs,
    defaultBranch,
}: {
    pr: StackPr;
    openPrs: StackPr[];
    defaultBranch: string;
}): string {
    const children = openPrs.filter(
        (candidate) => candidate.baseRefName === pr.headRefName && candidate.number !== pr.number
    );
    if (pr.baseRefName === defaultBranch && children.length === 0) {
        return "This PR is not part of a stack.";
    }

    const parents: string[] = [];
    const seen = new Set([pr.headRefName]);
    let base = pr.baseRefName;
    while (base !== defaultBranch) {
        if (seen.has(base)) {
            parents.push(`Base chain cycle detected at ${base}.`);
            break;
        }

        seen.add(base);
        const parent = openPrs.find((candidate) => candidate.headRefName === base);
        if (!parent) {
            parents.push(`No open PR found for base branch ${base}.`);
            break;
        }

        parents.push(`#${parent.number} ${parent.headRefName}`);
        base = parent.baseRefName;
    }

    return [
        `Parent chain, nearest first: ${parents.length ? parents.join(" -> ") : `none (base ${defaultBranch})`}`,
        `Direct children: ${children.length ? children.map((child) => `#${child.number} ${child.headRefName}`).join(", ") : "none"}`,
        "Push the parent before the child.",
        "When a parent or child PR also changes a file, keep its change working and name that file in the reply.",
    ].join("\n");
}
