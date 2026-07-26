/**
 * Is a FABLE-SPEC proposal ready to generate the skill from?
 *
 * The spec stage reports what IT did (passes, rejections, bullet counts). This reads
 * the finished document the way the skill stage will and answers the separate
 * question: is this still a list of principles? The v6 proposal passed every stage
 * metric and was still unusable — 55 of its 78 bullets over 400 characters, the worst
 * holding 4_363, because a line budget is satisfied by making lines longer.
 *
 * Usage: bun scripts/learn-from-fable/audit-spec.ts <spec.md> [baseline.md]
 */
import { readFileSync } from "node:fs";

const CAP = 420;
/** Two bullets sharing this share of their vocabulary are saying the same thing twice. */
const DUPLICATE_OVERLAP = 0.6;

interface Bullet {
    line: number;
    text: string;
    section: string;
}

function readBullets(markdown: string): { bullets: Bullet[]; sections: string[] } {
    const bullets: Bullet[] = [];
    const sections: string[] = [];
    let section = "(preamble)";

    markdown.split("\n").forEach((line, i) => {
        const heading = line.match(/^##\s+(.*)$/);
        if (heading) {
            section = heading[1].trim();
            sections.push(section);
            return;
        }

        if (/^\s*[-*]\s/.test(line)) {
            bullets.push({ line: i + 1, text: line, section });
        }
    });

    return { bullets, sections };
}

function words(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 3)
    );
}

function overlap(a: Set<string>, b: Set<string>): number {
    let shared = 0;
    for (const w of a) {
        if (b.has(w)) {
            shared++;
        }
    }

    return shared / Math.min(a.size, b.size);
}

function audit(path: string): void {
    const markdown = readFileSync(path, "utf-8");
    const { bullets, sections } = readBullets(markdown);
    const lengths = bullets.map((b) => b.text.length).sort((a, b) => a - b);
    const over = bullets.filter((b) => b.text.length > CAP);
    // the skill is generated per-principle, so a bullet with no source is a bullet
    // nobody can trace back to a session when it turns out to be wrong
    const uncited = bullets.filter((b) => !/\*\([0-9a-f]{8}/.test(b.text));

    const vocab = bullets.map((b) => words(b.text));
    const dupes: string[] = [];
    for (let i = 0; i < bullets.length; i++) {
        for (let j = i + 1; j < bullets.length; j++) {
            if (overlap(vocab[i], vocab[j]) >= DUPLICATE_OVERLAP) {
                dupes.push(`  L${bullets[i].line} ~ L${bullets[j].line}: ${bullets[i].text.slice(2, 90)}…`);
            }
        }
    }

    const total = lengths.reduce((a, b) => a + b, 0);
    process.stdout.write(
        [
            `# ${path}`,
            `lines      ${markdown.split("\n").length}`,
            `sections   ${sections.length}  (${sections.join(" · ")})`,
            `bullets    ${bullets.length}`,
            `bullet len avg ${Math.round(total / bullets.length)}  median ${lengths[Math.floor(lengths.length / 2)]}  max ${lengths.at(-1)}`,
            `over ${CAP}    ${over.length}  (${Math.round((over.length / bullets.length) * 100)}%)`,
            `uncited    ${uncited.length}`,
            `near-dupes ${dupes.length}`,
            "",
            ...(over.length
                ? [
                      "## oversized",
                      ...over.slice(0, 8).map((b) => `  L${b.line} ${b.text.length}ch: ${b.text.slice(2, 90)}…`),
                      "",
                  ]
                : []),
            ...(dupes.length ? ["## near-duplicates", ...dupes.slice(0, 12), ""] : []),
            ...(uncited.length
                ? ["## uncited", ...uncited.slice(0, 8).map((b) => `  L${b.line}: ${b.text.slice(2, 90)}…`), ""]
                : []),
            "## bullets per section",
            ...sections.map(
                (s) =>
                    `  ${bullets
                        .filter((b) => b.section === s)
                        .length.toString()
                        .padStart(4)}  ${s}`
            ),
            "",
        ].join("\n")
    );
}

const [path, baseline] = process.argv.slice(2);
if (!path) {
    process.stdout.write("usage: bun scripts/learn-from-fable/audit-spec.ts <spec.md> [baseline.md]\n");
    process.exit(1);
}

if (baseline) {
    audit(baseline);
    process.stdout.write(`${"=".repeat(72)}\n`);
}

audit(path);
