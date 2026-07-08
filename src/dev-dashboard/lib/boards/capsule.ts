import { blobUrl } from "./blobs";
import type { AnnotationDto, CardDto } from "./types";

const THREAD_LIMIT = 5;
const CLIP = 300;

export function buildCapsule(a: AnnotationDto, card: CardDto, boardSlug: string): string {
    const rev = a.revisions[a.revisions.length - 1];
    const lines: string[] = [];
    lines.push(
        `# boards work №${a.id} · ${a.intent === "other" ? a.intentOther || "other" : a.intent} · board ${boardSlug}`
    );
    lines.push("");
    lines.push(`**Ask (rev ${a.revisions.length}):** ${rev?.prompt ?? a.prompt}`);
    lines.push(
        `**Region:** ${a.region.x},${a.region.y} ${a.region.w}×${a.region.h} px on \`${card.filePath || card.kind}\`` +
            (card.blobKey ? ` — image: ${blobUrl(card.blobKey)}` : "")
    );

    if (card.setRef) {
        lines.push(
            `**Source:** set \`${card.setRef}\` v${card.setVersion} (card ${card.id}, drawn on v${a.cardVersion})`
        );
    }
    const thread = a.messages.slice(-THREAD_LIMIT);

    if (thread.length > 0) {
        lines.push("**Thread (latest):**");
        for (const m of thread) {
            const body = m.body.length > CLIP ? `${m.body.slice(0, CLIP)}…` : m.body;
            lines.push(`- ${m.author}: ${body}`);
        }
    }
    lines.push(
        "**Protocol:** boards_set_status working → fix → push a new set version → boards_attach_after → " +
            "boards_reply (1-3 lines) → boards_set_status in_review. Never set resolved (user-only). " +
            'A 409 "cancelled" on any write = the user withdrew this item — revert your changes for it and move on.' +
            (a.intent === "reshoot" ? " (reshoot intent: NO code changes — recapture only.)" : "")
    );
    lines.push(
        "**Scope:** this board only — keep draining with the same scope; other boards belong to other sessions."
    );
    return lines.join("\n");
}
