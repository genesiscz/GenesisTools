import {
    type DashboardClient,
    ENDPOINTS,
    type QaRow,
    type VaultAppendReceiptDto,
    type VaultClipReceiptDto,
} from "@dd/contract";

export function clipLink(
    client: DashboardClient,
    input: { url: string; note?: string; idempotencyKey: string }
): Promise<VaultClipReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.vaultClip, body, { idempotencyKey });
}

export function appendText(
    client: DashboardClient,
    input: { text: string; folder?: string; name?: string; idempotencyKey: string }
): Promise<VaultAppendReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.vaultAppend, body, { idempotencyKey });
}

/** A Q→A entry as a vault note section: the question as the heading, the answer, the project and the time. */
export function qaNoteText(entry: Pick<QaRow, "question" | "answerMd" | "project" | "ts">): string {
    const heading = (entry.question ?? "Answer").split("\n")[0].slice(0, 120);
    const meta = [entry.project, entry.ts].filter(Boolean).join(" · ");
    return `## ${heading}\n\n${meta ? `${meta}\n\n` : ""}${entry.answerMd ?? ""}\n`;
}

/** Where a saved answer goes: the project's folder under the inbox, one Answers note per project. */
export function qaNoteTarget(project: string | null | undefined): { folder?: string; name: string } {
    const name = "Answers";
    return project ? { folder: `Inbox/${project.replace(/[\\/]/g, "-")}`, name } : { name };
}

export function looksLikeLink(text: string): boolean {
    return /^https?:\/\/\S+$/i.test(text.trim());
}
