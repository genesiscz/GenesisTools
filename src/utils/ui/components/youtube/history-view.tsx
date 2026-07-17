import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import type { ActionHistoryGroup, VideoHistoryGroup, VideoLite } from "@app/youtube/lib/types";

export interface HistoryViewProps {
    mode: "video" | "action";
    onModeChange: (mode: "video" | "action") => void;
    videoGroups?: VideoHistoryGroup[];
    actionGroups?: ActionHistoryGroup[];
    videosById: Record<string, VideoLite | undefined>;
    onOpenVideo: (videoId: string) => void;
    loading?: boolean;
}

/** Friendly labels for the frozen history action vocabulary. */
const ACTION_LABELS: Record<string, string> = {
    watch: "Opened video",
    "summary:view": "Read summary",
    "insights:view": "Viewed insights",
    "transcript:view": "Read transcript",
    "comments:view": "Browsed comments",
    ask: "Asked a question",
};

function actionLabel(action: string): string {
    if (ACTION_LABELS[action]) {
        return ACTION_LABELS[action];
    }

    if (action.startsWith("job:")) {
        return `Ran ${action.slice(4)}`;
    }

    return action;
}

export function HistoryView({
    mode,
    onModeChange,
    videoGroups,
    actionGroups,
    videosById,
    onOpenVideo,
    loading,
}: HistoryViewProps) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    variant={mode === "video" ? "default" : "outline"}
                    onClick={() => onModeChange("video")}
                >
                    By video
                </Button>
                <Button
                    size="sm"
                    variant={mode === "action" ? "default" : "outline"}
                    onClick={() => onModeChange("action")}
                >
                    By action
                </Button>
            </div>
            {loading ? <p className="text-sm text-muted-foreground">Loading history…</p> : null}
            {mode === "video"
                ? (videoGroups ?? []).map((group) => (
                      <Card key={group.videoId}>
                          <CardHeader>
                              <CardTitle className="flex items-center justify-between gap-3 text-base">
                                  <button
                                      type="button"
                                      className="truncate text-left hover:underline"
                                      onClick={() => onOpenVideo(group.videoId)}
                                  >
                                      {videosById[group.videoId]?.title ?? group.videoId}
                                  </button>
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                      {new Date(group.lastTs).toLocaleString()}
                                  </span>
                              </CardTitle>
                          </CardHeader>
                          <CardContent className="flex flex-wrap gap-2">
                              {Object.entries(group.counts).map(([action, count]) => (
                                  <Badge key={action} variant="secondary">
                                      {actionLabel(action)} ×{count}
                                  </Badge>
                              ))}
                          </CardContent>
                      </Card>
                  ))
                : (actionGroups ?? []).map((group) => (
                      <Card key={group.action}>
                          <CardHeader>
                              <CardTitle className="text-base">
                                  {actionLabel(group.action)} <Badge variant="secondary">×{group.count}</Badge>
                              </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-1">
                              {group.entries.slice(0, 20).map((entry, index) => (
                                  <button
                                      key={`${entry.videoId}-${entry.ts}-${index}`}
                                      type="button"
                                      className="block w-full truncate text-left text-sm text-muted-foreground hover:underline"
                                      onClick={() => onOpenVideo(entry.videoId)}
                                  >
                                      {new Date(entry.ts).toLocaleString()} —{" "}
                                      {videosById[entry.videoId]?.title ?? entry.videoId}
                                  </button>
                              ))}
                          </CardContent>
                      </Card>
                  ))}
        </div>
    );
}
