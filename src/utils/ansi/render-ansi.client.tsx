import type { CSSProperties, ReactElement, ReactNode } from "react";

function sanitizeAnsiForDisplay(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

const CSI_PATTERN = /\u001b\[([\?]?[0-9;]*)([@-~])/g;

const ANSI_FG: Record<number, string> = {
    30: "var(--ansi-black)",
    31: "var(--ansi-red)",
    32: "var(--ansi-green)",
    33: "var(--ansi-yellow)",
    34: "var(--ansi-blue)",
    35: "var(--ansi-magenta)",
    36: "var(--ansi-cyan)",
    37: "var(--ansi-white)",
    90: "var(--ansi-bright-black)",
    91: "var(--ansi-bright-red)",
    92: "var(--ansi-bright-green)",
    93: "var(--ansi-bright-yellow)",
    94: "var(--ansi-bright-blue)",
    95: "var(--ansi-bright-magenta)",
    96: "var(--ansi-bright-cyan)",
    97: "var(--ansi-bright-white)",
};

const ANSI_BG: Record<number, string> = {
    40: "var(--ansi-bg-black)",
    41: "var(--ansi-bg-red)",
    42: "var(--ansi-bg-green)",
    43: "var(--ansi-bg-yellow)",
    44: "var(--ansi-bg-blue)",
    45: "var(--ansi-bg-magenta)",
    46: "var(--ansi-bg-cyan)",
    47: "var(--ansi-bg-white)",
    100: "var(--ansi-bg-bright-black)",
    101: "var(--ansi-bg-bright-red)",
    102: "var(--ansi-bg-bright-green)",
    103: "var(--ansi-bg-bright-yellow)",
    104: "var(--ansi-bg-bright-blue)",
    105: "var(--ansi-bg-bright-magenta)",
    106: "var(--ansi-bg-bright-cyan)",
    107: "var(--ansi-bg-bright-white)",
};

interface AnsiStyle {
    color?: string;
    backgroundColor?: string;
    fontWeight?: CSSProperties["fontWeight"];
    opacity?: number;
    fontStyle?: CSSProperties["fontStyle"];
    textDecoration?: CSSProperties["textDecoration"];
}

function defaultStyle(): AnsiStyle {
    return {};
}

function cloneStyle(style: AnsiStyle): AnsiStyle {
    return { ...style };
}

function applyCodes(style: AnsiStyle, codes: number[]): AnsiStyle {
    let next = cloneStyle(style);

    for (const code of codes) {
        if (code === 0) {
            next = defaultStyle();
            continue;
        }

        if (code === 1) {
            next.fontWeight = 700;
            continue;
        }

        if (code === 2) {
            next.opacity = 0.65;
            continue;
        }

        if (code === 3) {
            next.fontStyle = "italic";
            continue;
        }

        if (code === 4) {
            next.textDecoration = "underline";
            continue;
        }

        if (code === 22) {
            next.fontWeight = undefined;
            continue;
        }

        if (code === 23) {
            next.fontStyle = undefined;
            continue;
        }

        if (code === 24) {
            next.textDecoration = undefined;
            continue;
        }

        if (ANSI_FG[code]) {
            next.color = ANSI_FG[code];
            continue;
        }

        if (ANSI_BG[code]) {
            next.backgroundColor = ANSI_BG[code];
        }
    }

    return next;
}

function parseCodes(raw: string): number[] {
    if (!raw) {
        return [0];
    }

    return raw.split(";").map((part) => Number.parseInt(part, 10)).filter((n) => Number.isFinite(n));
}

export function ansiToReactNodes(text: string): ReactNode[] {
    const nodes: ReactNode[] = [];
    let style = defaultStyle();
    let lastIndex = 0;
    let key = 0;

    CSI_PATTERN.lastIndex = 0;

    for (const match of text.matchAll(CSI_PATTERN)) {
        const index = match.index ?? 0;
        const chunk = text.slice(lastIndex, index);

        if (chunk) {
            nodes.push(
                <span key={key} style={style}>
                    {chunk}
                </span>
            );
            key += 1;
        }

        if (match[2] !== "m") {
            lastIndex = index + match[0].length;
            continue;
        }

        style = applyCodes(style, parseCodes(match[1] ?? ""));
        lastIndex = index + match[0].length;
    }

    const tail = text.slice(lastIndex);
    if (tail) {
        nodes.push(
            <span key={key} style={style}>
                {tail}
            </span>
        );
    }

    if (nodes.length === 0) {
        return [text];
    }

    return nodes;
}

interface Props {
    text: string;
    className?: string;
}

export function AnsiLogText({ text, className = "" }: Props): ReactElement {
    return (
        <span className={`ansi-log ${className}`}>{ansiToReactNodes(sanitizeAnsiForDisplay(text))}</span>
    );
}
