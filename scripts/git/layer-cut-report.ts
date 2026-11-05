export interface ReportBranch {
    name: string;
    parent: string;
    commit: string;
    fileList: string[];
    files: number;
    added: number;
    modified: number;
    deleted: number;
    typecheck: { ok: boolean; knownErrors: string[] } | null;
    tests: { ok: boolean; summary: string } | null;
    swift: { ok: boolean; summary?: string } | null;
}

export interface CutReport {
    unified: string;
    base: string;
    branches: ReportBranch[];
}

export function overlayPlan(branches: readonly Pick<ReportBranch, "name" | "parent" | "commit" | "fileList">[]) {
    return branches.flatMap((branch) => branch.fileList.map((file) => ({ commit: branch.commit, file })));
}

export function classifyDifferences(
    files: readonly string[],
    owners: ReadonlyMap<string, number[]>,
    listed: ReadonlySet<string>
) {
    const owned: { file: string; prs: number[] }[] = [];
    const sourceOnly: string[] = [];
    const unexplained: string[] = [];
    for (const file of files) {
        const prs = owners.get(file);
        if (prs?.length) {
            owned.push({ file, prs: [...new Set(prs)].sort((a, b) => a - b) });
        } else {
            sourceOnly.push(file);
            if (!listed.has(file)) {
                unexplained.push(file);
            }
        }
    }
    return { owned, sourceOnly, unexplained };
}

function folders(files: readonly string[]): string {
    const counts = new Map<string, number>();
    for (const file of files) {
        const parts = file.split("/");
        const depth = file.startsWith("src/utils/") || file.startsWith("src/macos/") ? 3 : 2;
        const folder = parts.length > depth ? `${parts.slice(0, depth).join("/")}/` : file;
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([folder, count]) => `- \`${folder}\`: ${count}`)
        .join("\n");
}

export function buildBody(params: {
    report: CutReport;
    branch: ReportBranch;
    baseSha: string;
    prs: ReadonlyMap<string, number>;
    oldBody: string;
    extra?: string;
}): string {
    const { report, branch, baseSha, prs, oldBody, extra } = params;
    const notesAt = oldBody.search(/^## Notes for review[ \t]*\r?$/m);
    const notes = notesAt < 0 ? "" : oldBody.slice(notesAt);
    const stack = report.branches
        .map(
            (item, index) =>
                `${index + 1}. #${prs.get(item.name)} \`${item.name}\` (${item.files} files) on \`${item.parent}\``
        )
        .join("\n");
    const typecheck = branch.typecheck
        ? branch.typecheck.ok
            ? `passes (known errors: ${branch.typecheck.knownErrors.join(", ") || "none"})`
            : "FAILED"
        : "not run";
    const tests = branch.tests ? `${branch.tests.ok ? "passed" : "FAILED"}: ${branch.tests.summary}` : "not run";
    const swift = branch.swift
        ? `${branch.swift.ok ? "passed" : "FAILED"}${branch.swift.summary ? `: ${branch.swift.summary}` : ""}`
        : "not run";
    const text = [
        `Cut as an exact tree from unified \`${report.unified}\` and base \`${baseSha}\`: each layer starts from its parent and takes the listed files from unified, except files derived by the cut table.`,
        "",
        `**${branch.files} files**: ${branch.added} added, ${branch.modified} changed, ${branch.deleted} deleted.`,
        ...(extra ? ["", extra] : []),
        "",
        "## What this layer holds",
        folders(branch.fileList),
        "",
        "## Checks on this layer",
        `- Typecheck: ${typecheck}`,
        `- Tests: ${tests}`,
        `- Swift build: ${swift}`,
        "",
        "## The stack",
        stack,
    ].join("\n");
    return notes ? `${text}\n\n${notes}` : `${text}\n`;
}
