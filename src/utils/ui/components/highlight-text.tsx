import { splitTextByHighlights } from "@app/utils/highlight-text-spans";
import { cn } from "@ui/lib/utils";
import { useMemo, type ReactElement } from "react";

interface Props {
    text: string;
    tokens: string[];
    className?: string;
    markClassName?: string;
}

export function HighlightText({ text, tokens, className, markClassName }: Props): ReactElement {
    const spans = useMemo(() => splitTextByHighlights(text, tokens), [text, tokens]);

    return (
        <span className={className}>
            {spans.map((span, index) => {
                if (!span.highlight) {
                    return <span key={index}>{span.text}</span>;
                }

                return (
                    <mark key={index} className={cn("fuzzy-mark", markClassName)}>
                        {span.text}
                    </mark>
                );
            })}
        </span>
    );
}
