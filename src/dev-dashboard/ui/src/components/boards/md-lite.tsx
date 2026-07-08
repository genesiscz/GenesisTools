import type { ReactNode } from "react";

const INLINE_TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/;

/** Inline `**bold**` and `` `code` `` spans — no nesting, no other markdown. */
function renderInline(text: string): ReactNode {
    const parts: ReactNode[] = [];
    let rest = text;
    let key = 0;

    while (rest.length > 0) {
        const match = INLINE_TOKEN.exec(rest);

        if (!match) {
            parts.push(rest);
            break;
        }

        if (match.index > 0) {
            parts.push(rest.slice(0, match.index));
        }

        const token = match[0];
        parts.push(
            token.startsWith("**") ? (
                <strong key={key++}>{token.slice(2, -2)}</strong>
            ) : (
                <code key={key++}>{token.slice(1, -1)}</code>
            )
        );
        rest = rest.slice(match.index + token.length);
    }

    return parts;
}

/**
 * Minimal markdown for text-kind board cards: `#`/`##`/`###` headings, `- ` list
 * items, and inline `**bold**`/`` `code` ``. No dependency, no tables/links/blockquotes
 * — the dd-markdown renderer (used by Obsidian notes) is the real thing for prose;
 * this is just enough for a sticky-note-sized card.
 */
export function renderMdLite(md: string): ReactNode {
    const blocks: ReactNode[] = [];
    let listItems: string[] = [];

    const flushList = () => {
        if (listItems.length === 0) {
            return;
        }

        blocks.push(
            <ul key={`ul-${blocks.length}`} className="list-disc pl-5">
                {listItems.map((item, i) => (
                    <li key={i}>{renderInline(item)}</li>
                ))}
            </ul>
        );
        listItems = [];
    };

    md.split("\n").forEach((line, i) => {
        if (line.startsWith("- ")) {
            listItems.push(line.slice(2));
            return;
        }

        flushList();

        if (line.startsWith("### ")) {
            blocks.push(
                <h4 key={i} className="text-sm font-semibold">
                    {renderInline(line.slice(4))}
                </h4>
            );
        } else if (line.startsWith("## ")) {
            blocks.push(
                <h3 key={i} className="text-base font-semibold">
                    {renderInline(line.slice(3))}
                </h3>
            );
        } else if (line.startsWith("# ")) {
            blocks.push(
                <h2 key={i} className="text-lg font-semibold">
                    {renderInline(line.slice(2))}
                </h2>
            );
        } else if (line.trim() === "") {
            blocks.push(<div key={i} className="h-2" />);
        } else {
            blocks.push(<p key={i}>{renderInline(line)}</p>);
        }
    });
    flushList();

    return <>{blocks}</>;
}
