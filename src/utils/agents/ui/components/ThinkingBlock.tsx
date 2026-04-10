import type { ThinkingBlockProps } from "../types";

export function ThinkingBlock({ content, defaultExpanded = false }: ThinkingBlockProps) {
    return (
        <details className="text-muted-foreground" open={defaultExpanded}>
            <summary className="cursor-pointer text-sm italic select-none">Thinking...</summary>
            <pre className="mt-2 text-xs whitespace-pre-wrap leading-relaxed">{content}</pre>
        </details>
    );
}
