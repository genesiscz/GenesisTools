import type { BrowserCandidate, BrowserObservation } from "./types";

const UID = /(?:uid|ref)=([A-Za-z0-9_-]+)/i;
const ROLE_NAME = /\b(button|link|textbox|text box|heading|checkbox|radio|combobox|tab|menuitem)\b/i;

export function parseSnapshotText(text: string, url = "", title = ""): BrowserObservation {
    const candidates: BrowserCandidate[] = [];
    const headings: Array<{ level: number; text: string }> = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        const heading = line.match(/^heading\s+"([^"]+)"\s*\[level=(\d+)\]/i) ?? line.match(/^#+\s+(.+)$/);
        if (heading) {
            const level = heading[2] ? Number(heading[2]) : heading[0].startsWith("#") ? heading[0].indexOf(" ") : 1;
            headings.push({ level: Number.isFinite(level) && level > 0 ? level : 1, text: heading[1] });
        }
        const uid = line.match(UID)?.[1];
        if (!uid) {
            continue;
        }
        const quoted = line.match(/"([^"]+)"/);
        const roleMatch = line.match(ROLE_NAME);
        const role = (roleMatch?.[1] ?? "generic").toLowerCase().replace("text box", "textbox");
        const name = quoted?.[1] ?? uid;
        candidates.push({
            uid,
            role,
            name,
            clickable: ["button", "link", "checkbox", "radio", "tab", "menuitem"].includes(role),
            fillable: role === "textbox" || role === "combobox",
        });
    }
    if (candidates.length > 80) {
        throw new Error("More than 80 browser candidates. Narrow the snapshot.");
    }
    return { url, title, candidates, headings };
}

export function mapInput(
    candidates: BrowserCandidate[],
    inputs: Record<string, string>,
    uid: string
): string | undefined {
    const target = candidates.find((candidate) => candidate.uid === uid);
    if (!target?.fillable) {
        return undefined;
    }
    const key = Object.keys(inputs).find((name) => name.toLowerCase() === target.name.toLowerCase());
    return key ? inputs[key] : undefined;
}
