import { Button } from "@app/utils/ui/components/button";
import { Markdown } from "@app/utils/ui/components/markdown";
import { LlmConfirmDialog } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import type { VideoReport } from "@app/youtube/lib/types";
import { useCreateReport, useReport, useReportEstimate } from "@ext/api.hooks";
import type { ReportMemberMeta } from "@ext/shared/messages";
import { Header } from "@ext/side-panel/header";
import { ChevronLeft, FileText, ListVideo, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

const MAX_REPORT_MEMBERS = 20;

/** Scrape the playlist page's member video ids (content-script context — the
 *  shadow-DOM panel shares the page's document). Capped at the report limit. */
function collectPlaylistVideoIds(): string[] {
    const anchors = document.querySelectorAll<HTMLAnchorElement>(
        'ytd-playlist-video-renderer a[href*="watch?v="], ytd-playlist-panel-video-renderer a[href*="watch?v="]'
    );
    const ids: string[] = [];

    for (const anchor of anchors) {
        const id = new URL(anchor.href, location.origin).searchParams.get("v");

        if (id && !ids.includes(id)) {
            ids.push(id);
        }

        if (ids.length >= MAX_REPORT_MEMBERS) {
            break;
        }
    }

    return ids;
}

export function PlaylistPanel({ listId }: { listId: string }) {
    const [collapsed, setCollapsed] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [reportId, setReportId] = useState<number | null>(null);
    const memberIds = useMemo(() => collectPlaylistVideoIds(), []);
    const estimate = useReportEstimate(memberIds, confirmOpen);
    const create = useCreateReport();
    const report = useReport(reportId);

    async function runCreate() {
        const created = await create.mutateAsync({
            videoIds: memberIds,
            title: document.title.replace(/ - YouTube$/, ""),
        });
        setConfirmOpen(false);
        setReportId(created.report.id);
    }

    return (
        <div className="flex h-auto max-h-[min(70vh,720px)] min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-card shadow-2xl shadow-black/40">
            <Header collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />
            <div className="yt-body-collapsible min-h-0 flex-1" data-collapsed={collapsed}>
                <div className="yt-scroll min-h-0 h-full space-y-4 overflow-auto p-4">
                    {reportId !== null ? (
                        <ReportView
                            report={report.data?.report.result ?? null}
                            members={report.data?.members ?? {}}
                            title={report.data?.report.title ?? "Report"}
                            error={
                                report.isError
                                    ? report.error instanceof Error
                                        ? report.error.message
                                        : "Couldn't load this report."
                                    : null
                            }
                            timedOut={report.pollTimedOut}
                            onBack={() => setReportId(null)}
                        />
                    ) : (
                        <>
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">
                                        Playlist
                                    </p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {memberIds.length} video{memberIds.length === 1 ? "" : "s"} detected · list{" "}
                                        {listId}
                                    </p>
                                </div>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    data-testid="playlist-generate-report"
                                    onClick={() => setConfirmOpen(true)}
                                    disabled={memberIds.length < 2 || create.isPending}
                                >
                                    <FileText className="size-4" /> Generate report
                                </Button>
                            </div>
                            {memberIds.length < 2 ? (
                                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                                    <ListVideo className="mt-0.5 size-5 shrink-0 text-primary" />
                                    <p className="text-sm text-muted-foreground">
                                        Reports need at least 2 videos. Scroll the playlist so its entries render, then
                                        reopen the panel.
                                    </p>
                                </div>
                            ) : (
                                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                                    <FileText className="mt-0.5 size-5 shrink-0 text-primary" />
                                    <p className="text-sm text-muted-foreground">
                                        Generate one combined report across the first {memberIds.length} videos:
                                        shared themes, contradictions, per-video highlights, and a watch/skip verdict.
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
            <LlmConfirmDialog
                open={confirmOpen}
                title="Generate multi-video report?"
                description={`Ensures every video has a summary, then combines them into one report across ${memberIds.length} videos.`}
                payloadSummary="Uses each video's summary only — never the full transcript."
                busy={create.isPending}
                confirmLabel="Generate report"
                error={create.error ? create.error.message : null}
                billingNote={
                    estimate.data ? (
                        <>
                            will cost ~<span className="font-semibold tabular-nums">{estimate.data.creditCost} 💎</span>{" "}
                            (<span className="font-semibold tabular-nums">{estimate.data.membersNeedingSummary}</span>{" "}
                            video{estimate.data.membersNeedingSummary === 1 ? "" : "s"} need summaries)
                        </>
                    ) : (
                        "Estimating cost…"
                    )
                }
                onCancel={() => setConfirmOpen(false)}
                onConfirm={runCreate}
            />
        </div>
    );
}

function ReportView({
    report,
    members,
    title,
    error,
    timedOut,
    onBack,
}: {
    report: VideoReport | null;
    members: Record<string, ReportMemberMeta>;
    title: string;
    error?: string | null;
    timedOut?: boolean;
    onBack: () => void;
}) {
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ChevronLeft className="size-4" />
                </button>
                <h2 className="truncate text-lg font-semibold text-foreground/95">{title}</h2>
            </div>
            {report === null ? (
                error ? (
                    <div className="flex items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4">
                        <p className="text-sm text-destructive/90">{error}</p>
                    </div>
                ) : timedOut ? (
                    <div className="flex items-start gap-3 rounded-2xl border border-white/8 bg-black/20 p-4">
                        <p className="text-sm text-muted-foreground">
                            This is taking longer than expected — check the dashboard for the report's progress.
                        </p>
                    </div>
                ) : (
                    <div className="flex items-start gap-3 rounded-2xl border border-white/8 bg-black/20 p-4">
                        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">
                            Generating… each video is summarized first, then combined into one report. This view
                            refreshes automatically.
                        </p>
                    </div>
                )
            ) : (
                <>
                    <div>
                        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">overview</p>
                        <Markdown md={report.overview} className="yt-md mt-2" />
                    </div>
                    <div className="space-y-3">
                        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">themes</p>
                        {report.themes.map((theme) => (
                            <div key={theme.title} className="rounded-2xl border border-white/8 bg-black/20 p-3">
                                <p className="text-sm font-semibold text-foreground/95">{theme.title}</p>
                                <p className="mt-1 text-sm text-muted-foreground">{theme.detail}</p>
                            </div>
                        ))}
                    </div>
                    {report.disagreements.length > 0 ? (
                        <div className="space-y-3">
                            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">
                                disagreements
                            </p>
                            {report.disagreements.map((entry) => (
                                <div key={entry.topic} className="rounded-2xl border border-white/8 bg-black/20 p-3">
                                    <p className="text-sm font-semibold text-foreground/95">{entry.topic}</p>
                                    <p className="mt-1 text-sm text-muted-foreground">{entry.positions}</p>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <div className="space-y-3">
                        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">videos</p>
                        {report.perVideo.map((entry) => {
                            const meta = members[entry.videoId];

                            return (
                                <div key={entry.videoId} className="rounded-2xl border border-white/8 bg-black/20 p-3">
                                    <div className="flex items-center gap-2">
                                        {meta?.thumbUrl ? (
                                            <img
                                                src={meta.thumbUrl}
                                                alt=""
                                                className="h-6 w-10 rounded-md object-cover"
                                            />
                                        ) : null}
                                        <span className="truncate text-sm font-medium">
                                            {meta?.title ?? entry.videoId}
                                        </span>
                                        {meta?.uploadDate ? (
                                            <span className="text-[12px] font-mono text-muted-foreground">
                                                {meta.uploadDate}
                                            </span>
                                        ) : null}
                                    </div>
                                    {entry.skipped !== null ? (
                                        <p className="mt-2 text-sm text-amber-200/90">Skipped: {entry.skipped}</p>
                                    ) : (
                                        <>
                                            <p className="mt-2 text-sm text-muted-foreground">{entry.capsule}</p>
                                            {entry.standout ? (
                                                <p className="mt-1 text-sm text-foreground/85">{entry.standout}</p>
                                            ) : null}
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div className="rounded-2xl border border-primary/25 bg-black/20 p-3">
                        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">verdict</p>
                        <p className="mt-1 text-sm text-foreground/90">{report.recommendation}</p>
                    </div>
                </>
            )}
        </div>
    );
}
