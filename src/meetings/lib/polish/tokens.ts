import { parseClock } from "@genesiscz/utils/transcribe/render";

/** How one part's times are written: a play link where a link can go, and plain text inside a code fence. */
export interface PartTimes {
    record: string;
    /** Written before the time in plain text (a diff block), so the reader knows which recording it is in. */
    marker?: string;
    /** The play link of a moment of this record; null where the router gives none. */
    link: (atSec: number) => string | null;
}

/** `[[t:43:15]]`: a time in one part, named by the part's token. */
const TOKEN_RE = /\[\[([a-z]+):(\d+(?::\d{2}){1,2})\]\]/g;
const FENCE_RE = /(```[\s\S]*?```)/;

/** `13:49` with its play link in a superscript, the form polishing.md asks for; the bare time when there is no link. */
export function playTime(label: string, link: string | null): string {
    return link ? `\`${label}\`<sup>[play](${link})</sup>` : `\`${label}\``;
}

/**
 * Turns every `[[<token>:MM:SS]]` into its part's play link, and inside a code fence into plain text with the part's
 * marker (`15:20 recording 01:05`), since a link cannot work there. A token that names no part stays as written and
 * is reported in `unknown`.
 */
export function renderTimes(text: string, parts: ReadonlyMap<string, PartTimes>, unknown?: Set<string>): string {
    return text
        .split(FENCE_RE)
        .map((piece) => {
            const fenced = piece.startsWith("```");
            return piece.replace(TOKEN_RE, (whole, token: string, time: string) => {
                const part = parts.get(token);
                const atSec = parseClock(time);

                if (!part || atSec === undefined) {
                    unknown?.add(whole);
                    return whole;
                }

                if (fenced) {
                    return part.marker ? `${part.marker} ${time}` : time;
                }

                return playTime(time, part.link(atSec));
            });
        })
        .join("");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Writes the bare `MM:SS` times on bullet lines as tokens: a time right after a part's marker belongs to that part,
 * any other to `fallback`. A time glued to a word, a colon or a dot (`v1:2`, `10:30:00.5`) is not one.
 */
export function tokenizeBareTimes(text: string, fallback: string, markers: ReadonlyMap<string, string>): string {
    const byMarker = [...markers.entries()].filter(([marker]) => marker !== "");
    const prefix =
        byMarker.length > 0 ? `(${byMarker.map(([marker]) => escapeRegExp(`${marker} `)).join("|")})?` : "()?";
    const re = new RegExp(`${prefix}(?<![\\w:.])(\\d{1,2}:\\d{2}(?::\\d{2})?)(?![\\w:])`, "g");
    const tokenOf = new Map(byMarker.map(([marker, token]) => [`${marker} `, token]));

    return text
        .split("\n")
        .map((line) =>
            line.startsWith("- ")
                ? line.replace(re, (_whole, before: string | undefined, time: string) =>
                      before ? `${before}[[${tokenOf.get(before)}:${time}]]` : `[[${fallback}:${time}]]`
                  )
                : line
        )
        .join("\n");
}

/** `{name}` placeholders filled from `values`; a name with no value stays as written. */
export function fillPhrase(template: string, values: Record<string, string | number | null | undefined>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const value = values[name];
        return value === undefined || value === null ? whole : String(value);
    });
}

/** `0.85` as `85 %`. */
export function percentText(confidence: number): string {
    return `${Math.round(confidence * 100)} %`;
}
