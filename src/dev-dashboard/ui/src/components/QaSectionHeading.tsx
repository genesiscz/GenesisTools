interface QaSectionHeadingProps {
    label: "Question" | "Answer";
}

export function QaSectionHeading({ label }: QaSectionHeadingProps) {
    return (
        <div className="dd-qa-section-heading">
            <span className="dd-qa-section-heading-bar" aria-hidden />
            <h3 className="dd-accent-text text-xs font-bold uppercase tracking-widest">{label}</h3>
        </div>
    );
}
