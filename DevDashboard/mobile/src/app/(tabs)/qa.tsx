import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { QaFeed } from "@/features/qa/components/QaFeed";
import { QaFilterBar } from "@/features/qa/components/QaFilterBar";
import { QaLiveDot } from "@/features/qa/components/QaLiveDot";
import { useMarkRead, useQaLog, useQaStream } from "@/features/qa/hooks";
import { filterQa, mergeQaRows, persistQaReadToggle, projectsOf, tagsOf } from "@/features/qa/live-feed";
import { Loading } from "@/ui/Loading";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

/**
 * QA LIVE-STREAM screen. Persisted log (`useQaLog`) merged with the live SSE buffer (`useQaStream`),
 * deduped by id, filtered by project / tag / free text, rendered as a `QaFeed`. Tapping a card
 * toggles read/unread optimistically (a session-local override) and persists via `useMarkRead`
 * (`POST /api/qa/read`), which invalidates the log so the server `readAt` reconciles on the next
 * fetch. On AppState resume the stream re-opens and the log refetches (the web resync model).
 *
 * Consumes ONLY the QA feature hooks (D32) — no raw `useQuery`/`subscribe` here.
 */
export default function QaScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();

    const logQuery = useQaLog();
    const { live, status } = useQaStream({ onResume: () => void logQuery.refetch() });
    const markRead = useMarkRead();

    const [selectedProjects, setSelectedProjects] = useState<Set<string>>(() => new Set());
    const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set());
    const [text, setText] = useState("");
    const [locallyRead, setLocallyRead] = useState<Set<string>>(() => new Set());
    const [locallyUnread, setLocallyUnread] = useState<Set<string>>(() => new Set());
    const [readError, setReadError] = useState<string | null>(null);
    const readGeneration = useRef(new Map<string, number>());

    const merged = useMemo(
        () => mergeQaRows({ live, persisted: logQuery.data ?? [] }),
        [live, logQuery.data],
    );
    const projects = useMemo(() => projectsOf(merged), [merged]);
    const tags = useMemo(() => tagsOf(merged), [merged]);

    const selectedProjectsList = useMemo(() => [...selectedProjects], [selectedProjects]);
    const selectedTagsList = useMemo(() => [...selectedTags], [selectedTags]);

    const filtered = useMemo(
        () => filterQa(merged, { projects: selectedProjectsList, tags: selectedTagsList, text }),
        [merged, selectedProjectsList, selectedTagsList, text],
    );

    const onToggleProject = useCallback((p: string) => {
        setSelectedProjects((prev) => {
            const next = new Set(prev);
            if (next.has(p)) {
                next.delete(p);
            } else {
                next.add(p);
            }

            return next;
        });
    }, []);

    const onToggleTag = useCallback((t: string) => {
        setSelectedTags((prev) => {
            const next = new Set(prev);
            if (next.has(t)) {
                next.delete(t);
            } else {
                next.add(t);
            }

            return next;
        });
    }, []);

    const onClearProjects = useCallback(() => setSelectedProjects(new Set()), []);
    const onClearTags = useCallback(() => setSelectedTags(new Set()), []);

    const onToggleRead = useCallback(
        (id: string, nextUnread: boolean) => {
            if (!id) {
                return;
            }

            const generation = (readGeneration.current.get(id) ?? 0) + 1;
            readGeneration.current.set(id, generation);
            setReadError(null);
            setLocallyRead((prev) => {
                const next = new Set(prev);
                if (nextUnread) {
                    next.delete(id);
                } else {
                    next.add(id);
                }

                return next;
            });
            setLocallyUnread((prev) => {
                const next = new Set(prev);
                if (nextUnread) {
                    next.add(id);
                } else {
                    next.delete(id);
                }

                return next;
            });
            void persistQaReadToggle({
                persist: () => markRead.mutateAsync({ ids: [id], unread: nextUnread }),
                refetch: () => logQuery.refetch(),
                isCurrent: () => readGeneration.current.get(id) === generation,
                onRejected: (error) => {
                    setLocallyRead((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                    setLocallyUnread((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                    setReadError(error instanceof Error ? error.message : "Could not update read state.");
                },
                onAcknowledged: () => {
                    readGeneration.current.delete(id);
                    setLocallyRead((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                    setLocallyUnread((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                },
            });
        },
        [logQuery, markRead],
    );

    if (logQuery.isLoading && merged.length === 0) {
        return (
            <View testID="screen-qa" className="flex-1 bg-dd-bg-base">
                <Loading testID="qa-loading" label="Loading Q&A…" />
            </View>
        );
    }

    if (logQuery.isError && merged.length === 0) {
        return (
            <View testID="screen-qa" className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6">
                <Text testID="qa-error" className="text-base font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                    Q&A unavailable
                </Text>
                <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {logQuery.error instanceof Error ? logQuery.error.message : "Could not reach the agent."}
                </Text>
            </View>
        );
    }

    return (
        <View testID="screen-qa" className="flex-1 bg-dd-bg-base" style={{ paddingTop: insets.top + 8 }}>
            <View className="gap-3 px-4 pb-3">
                <View className="flex-row items-center justify-between">
                    <Text
                        accessibilityRole="header"
                        className="text-2xl font-bold"
                        style={{ color: c.accent, fontFamily: "monospace" }}
                    >
                        Q&amp;A stream
                    </Text>
                    <QaLiveDot status={status} />
                </View>

                <MockBadge />

                {readError ? (
                    <Text testID="qa-read-error" className="text-xs" style={{ color: c.danger }}>
                        {readError}
                    </Text>
                ) : null}

                <QaFilterBar
                    projects={projects}
                    tags={tags}
                    selectedProjects={selectedProjectsList}
                    selectedTags={selectedTagsList}
                    text={text}
                    onToggleProject={onToggleProject}
                    onToggleTag={onToggleTag}
                    onClearProjects={onClearProjects}
                    onClearTags={onClearTags}
                    onText={setText}
                />
            </View>

            <View className="flex-1 px-4">
                <QaFeed
                    rows={filtered}
                    locallyRead={locallyRead}
                    locallyUnread={locallyUnread}
                    totalCount={merged.length}
                    onToggleRead={onToggleRead}
                />
            </View>
        </View>
    );
}
