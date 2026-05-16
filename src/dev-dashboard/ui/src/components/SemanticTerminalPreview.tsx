import { classifyTerminalPreview } from "@/lib/terminal-colors";

interface Props {
    preview: string;
}

export function SemanticTerminalPreview({ preview }: Props) {
    const lines = classifyTerminalPreview(preview);

    return (
        <div className="dd-cmux-preview min-h-0 flex-1 overflow-auto" aria-label="cmux terminal snapshot">
            {lines.map((line, index) => (
                <div className={`dd-terminal-line dd-terminal-line--${line.kind}`} key={`${index}:${line.text}`}>
                    {line.text || "\u00A0"}
                </div>
            ))}
        </div>
    );
}
