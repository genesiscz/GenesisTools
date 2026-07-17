import { HistoryView } from "@app/utils/ui/components/youtube/history-view";
import { useHistory } from "@app/yt/api.hooks";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/history")({
    component: HistoryPage,
});

function HistoryPage() {
    const [mode, setMode] = useState<"video" | "action">("video");
    const history = useHistory(mode);
    const navigate = useNavigate();

    return (
        <div className="mx-auto max-w-4xl space-y-4 p-4">
            <h1 className="text-xl font-semibold">History</h1>
            <HistoryView
                mode={mode}
                onModeChange={setMode}
                videoGroups={history.data?.videos}
                actionGroups={history.data?.actions}
                videosById={history.data?.videosById ?? {}}
                onOpenVideo={(videoId) => void navigate({ to: "/videos/$id", params: { id: videoId } })}
                loading={history.isPending}
            />
        </div>
    );
}
