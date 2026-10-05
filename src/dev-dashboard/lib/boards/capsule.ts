import { blobUrl } from "./blobs";
import { containingSection, type SectionCard, sectionFrames, sectionTitle } from "./sections";
import type { AnnotationDto, CardDto } from "./types";

const THREAD_LIMIT = 5;
const CLIP = 300;

export function buildCapsule(
    a: AnnotationDto,
    card: CardDto,
    boardSlug: string,
    opts?: { boardCards?: SectionCard[]; base?: string }
): string {
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
    if (opts?.boardCards) {
        const section = containingSection(sectionFrames(opts.boardCards), card);
        if (section) {
            const name = sectionTitle(section);
            lines.push(
                `**Section:** ${name} — scoped digest: ${opts.base ?? ""}/api/boards/${boardSlug}/scrape?section=${encodeURIComponent(name)}`
            );
        }
    }
    const thread = a.messages.slice(-THREAD_LIMIT);

    if (thread.length > 0) {
        lines.push("**Thread (latest):**");
        for (const m of thread) {
            const body = m.body.length > CLIP ? `${m.body.slice(0, CLIP)}…` : m.body;
            lines.push(`- ${m.author}: ${body}`);
        }
    }
    const api = `/api/boards/annotations/${a.id}`;
    lines.push(
        a.intent === "reshoot"
            ? `**Protocol (reshoot):** NO code changes — the shot caught a bad state (loading/broken). ` +
                  `PATCH ${api} {"status":"working","session":"<work session>"} → re-capture this screen (route/surface in the set manifest for ` +
                  `\`${card.filePath || card.kind}\`), wait for the app to settle → push the new set version ` +
                  `(PUT /api/boards/sets/{project}/{branch}/{key}/content, tar.gz body) → POST ${api}/attempts ` +
                  `{project, branch, selector, file} → POST ${api}/messages {"body"} (1 line) → PATCH ${api} ` +
                  `{"status":"in_review"}. A 409 "cancelled" from ANY write means the user withdrew №${a.id}: ` +
                  `reply once, move on.`
            : `**Protocol:** PATCH ${api} {"status":"working","session":"<work session>"} → fix → push a new set version → POST ${api}/attempts ` +
                  `{project, branch, selector, file} → POST ${api}/messages {"body"} (1-3 lines) → PATCH ${api} ` +
                  `{"status":"in_review"}. Never set resolved (user-only). ` +
                  'A 409 "cancelled" on any write = the user withdrew this item — revert your changes for it and move on.'
    );
    lines.push(
        "**Claim:** send the `session` this work arrived with when you set it to working, so an expired lease reopens " +
            "the item instead of leaving it stuck."
    );
    lines.push(
        "**Scope:** this board only — keep draining with the same scope; other boards belong to other sessions."
    );
    return lines.join("\n");
}
