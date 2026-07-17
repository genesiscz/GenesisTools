import { Button } from "@app/utils/ui/components/button";
import { HistoryView } from "@app/utils/ui/components/youtube/history-view";
import { useMe, useUserHistory } from "@ext/api.hooks";
import { ActivityView } from "@ext/side-panel/activity-view";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

/** Sub-surfaces of the account hub. Grows as Phase 4a features land. */
export type AccountSection = "activity" | "history";

const SECTIONS: Array<{ id: AccountSection; label: string }> = [
    { id: "activity", label: "Activity" },
    { id: "history", label: "History" },
];

export function AccountView({
    section,
    onSectionChange,
    onBack,
    onRequireLogin,
    onOpenWatch,
}: {
    section: AccountSection;
    onSectionChange: (section: AccountSection) => void;
    onBack: () => void;
    onRequireLogin: (retry?: () => void) => void;
    onOpenWatch: (videoId: string, t: number) => void;
}) {
    const me = useMe();

    return (
        <div className="flex flex-col">
            <div className="space-y-2 border-b border-white/8 p-3">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ArrowLeft className="size-4" /> Back
                </button>
                <div className="flex gap-1 overflow-x-auto rounded-lg border border-white/8 bg-black/20 p-1">
                    {SECTIONS.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => onSectionChange(item.id)}
                            className={`h-7 shrink-0 rounded-md px-2.5 text-xs font-medium transition-colors ${
                                section === item.id
                                    ? "bg-white/10 text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>

            {!me.data?.user ? (
                <SignInPrompt onRequireLogin={onRequireLogin} />
            ) : section === "history" ? (
                <HistorySection onOpenWatch={onOpenWatch} />
            ) : (
                <ActivityView />
            )}
        </div>
    );
}

function SignInPrompt({ onRequireLogin }: { onRequireLogin: (retry?: () => void) => void }) {
    return (
        <div className="p-4">
            <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                <p className="text-sm text-muted-foreground">Sign in to see your history, collections, and digest.</p>
                <Button size="sm" onClick={() => onRequireLogin()}>
                    Sign in
                </Button>
            </div>
        </div>
    );
}

function HistorySection({ onOpenWatch }: { onOpenWatch: (videoId: string, t: number) => void }) {
    const [mode, setMode] = useState<"video" | "action">("video");
    const history = useUserHistory(mode);

    return (
        <div className="space-y-3 p-4">
            {history.isError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">
                        {history.error instanceof Error ? history.error.message : "Failed to load history."}
                    </p>
                </div>
            ) : null}
            <HistoryView
                mode={mode}
                onModeChange={setMode}
                videoGroups={history.data?.videos}
                actionGroups={history.data?.actions}
                videosById={history.data?.videosById ?? {}}
                onOpenVideo={(videoId) => onOpenWatch(videoId, 0)}
                loading={history.isPending}
            />
        </div>
    );
}
