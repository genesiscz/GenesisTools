import type { InboxDecision, InboxDialog } from "@app/question/lib/inbox/build";

export function QaDialogItem({ item }: { item: InboxDialog | InboxDecision }) {
    return (
        <div className="flex flex-col gap-2 border-t border-[var(--dd-border)]/60 pt-3" data-dialog-id={item.id}>
            <span className="font-medium text-[var(--dd-text-primary)]">{item.title ?? "Question"}</span>
            <p className="text-sm text-[var(--dd-text-primary)]">{item.prompt}</p>
            {item.choices.map((choice) => (
                <p key={choice.id} className="text-xs text-[var(--dd-text-secondary)]">
                    {choice.label}
                </p>
            ))}
            <p className="text-xs text-[var(--dd-text-muted)]">
                Use the session controls above to open the session and answer.
            </p>
        </div>
    );
}
