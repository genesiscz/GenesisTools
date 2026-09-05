interface ChipProps {
    pressed: boolean;
    color: string;
    label: string;
    onClick: () => void;
    title?: string;
}

/** A toggle chip. The dot shows selection state and doubles as the colour legend for the charts. */
export function Chip({ pressed, color, label, onClick, title }: ChipProps) {
    return (
        <button
            type="button"
            className="dd-ai-chip"
            aria-pressed={pressed}
            onClick={onClick}
            title={title}
            style={{ "--chip-color": color } as React.CSSProperties}
        >
            <span className="dd-ai-dot" />
            {label}
        </button>
    );
}
