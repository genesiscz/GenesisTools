import { useTerminalSize } from "@genesiscz/utils/ink/hooks/use-terminal-size";
import { Box, useInput } from "ink";
import { useCallback, useMemo, useRef, useState } from "react";
import { AlertBanner } from "./components/alert-banner";
import { HelpOverlay } from "./components/help-overlay";
import { StatusBar } from "./components/status-bar";
import { TabBar } from "./components/tab-bar";
import { cycleProvider, FilterBar, type FilterState } from "./filters";
import { useKeybindings } from "./hooks/use-keybindings";
import { usePoller } from "./hooks/use-poller";
import { useTabNavigation } from "./hooks/use-tab-navigation";
import { type TabDefinition, TIME_RANGES, type UsageDataSource } from "./types";
import { HistoryView } from "./views/history-view";
import { type OverviewSortMode, OverviewView } from "./views/overview-view";

const POLL_INTERVALS = [5, 10, 15, 30, 60] as const;

const BASE_TABS: TabDefinition[] = [
    { id: "overview", label: "Overview", shortcut: "1" },
    { id: "history", label: "History", shortcut: "2" },
];

export interface UsageDashboardProps {
    source: UsageDataSource;
    /** Initial `--account` filter. */
    accountFilter?: string[];
    /** Initial `--range` in minutes. */
    range?: number;
    /** Extra `?` overlay lines from the pinned provider's presenter. */
    helpLines?: Array<[string, string]>;
}

/**
 * The provider-neutral dashboard shell (spec 7.1). It owns the frame, the tabs, the
 * filters and the poll loop; everything provider-specific arrives through
 * `source.presenters`.
 */
export function UsageDashboard({ source, accountFilter, range, helpLines }: UsageDashboardProps) {
    const { rows } = useTerminalSize({ clearOnResize: true });

    const tabs = useMemo(
        () => [...BASE_TABS, ...(source.extraTabs ?? []).map(({ id, label, shortcut }) => ({ id, label, shortcut }))],
        [source.extraTabs]
    );
    const { activeTab, activeIndex } = useTabNavigation(tabs, source.config.defaultTab);

    const [pollInterval, setPollInterval] = useState<number>(
        POLL_INTERVALS.includes(source.config.refreshInterval as (typeof POLL_INTERVALS)[number])
            ? source.config.refreshInterval
            : 60
    );
    const [paused, setPaused] = useState(false);
    const [sortMode, setSortMode] = useState<OverviewSortMode>("urgency");
    const [accountPickerOpen, setAccountPickerOpen] = useState(false);
    const [, forceUpdate] = useState(0);
    const [filters, setFilters] = useState<FilterState>({
        provider: source.providers.length === 1 ? source.providers[0] : null,
        accounts: accountFilter ?? null,
        range: range ?? TIME_RANGES[0],
    });

    const cycleInterval = useCallback(() => {
        setPollInterval((current) => {
            const idx = POLL_INTERVALS.indexOf(current as (typeof POLL_INTERVALS)[number]);
            return POLL_INTERVALS[(idx + 1) % POLL_INTERVALS.length];
        });
    }, []);

    const { results, accountRefs, pollingLabel, lastRefresh, nextRefresh, dbVersion, notifications, forceRefresh } =
        usePoller({
            source,
            accountFilter: filters.accounts ?? undefined,
            paused,
            pollIntervalSeconds: pollInterval,
        });

    const forceRefreshRef = useRef(forceRefresh);
    forceRefreshRef.current = forceRefresh;

    // `f` belongs to the filter bar now, so the range applies to Overview pacing too.
    useInput(
        (input) => {
            if (input === "f") {
                setFilters((current) => {
                    const idx = TIME_RANGES.indexOf(current.range as (typeof TIME_RANGES)[number]);
                    return { ...current, range: TIME_RANGES[(idx + 1) % TIME_RANGES.length] };
                });
            }
        },
        { isActive: !accountPickerOpen }
    );

    const { showHelp, setShowHelp } = useKeybindings({
        onForceRefresh: () => forceRefreshRef.current(),
        onDismissAlert: () => {
            notifications?.dismissAll();
            forceUpdate((n) => n + 1);
        },
        onCycleInterval: cycleInterval,
        onTogglePause: () => setPaused((p) => !p),
        onToggleSort: () => setSortMode((mode) => (mode === "config" ? "urgency" : "config")),
        onCycleProvider:
            source.providers.length > 1
                ? () =>
                      setFilters((current) => ({
                          ...current,
                          provider: cycleProvider(current.provider, source.providers),
                      }))
                : undefined,
        onOpenAccountFilter: () => setAccountPickerOpen(true),
    });

    if (showHelp) {
        return <HelpOverlay onClose={() => setShowHelp(false)} extraLines={helpLines} />;
    }

    const visibleProviders = filters.provider ? [filters.provider] : source.providers;
    const filteredResults = results
        ? {
              ...results,
              accounts: results.accounts.filter(
                  (snapshot) => !filters.provider || snapshot.provider === filters.provider
              ),
          }
        : null;
    const extraTab = source.extraTabs?.find((tab) => tab.id === activeTab);

    return (
        // Clamp the frame STRICTLY below the viewport height: at >= rows Ink
        // abandons in-place erasing for clear-terminal-and-rewrite (ink.js
        // onRender), which scrolls overflow into scrollback and duplicates
        // stale frames on every refresh. The active view clips instead.
        <Box flexDirection="column" height={Math.max(1, rows - 1)} overflow="hidden">
            <FilterBar
                filters={filters}
                providers={source.providers}
                accounts={accountRefs}
                accountPickerOpen={accountPickerOpen}
                onCloseAccountPicker={() => setAccountPickerOpen(false)}
                onChange={setFilters}
            />
            <TabBar tabs={tabs} activeIndex={activeIndex} />
            <Box flexDirection="column" flexGrow={1} overflowY="hidden">
                {activeTab === "overview" && (
                    <OverviewView
                        results={filteredResults}
                        config={source.config}
                        presenters={source.presenters}
                        sortMode={sortMode}
                    />
                )}
                {activeTab === "history" && (
                    <HistoryView
                        db={source.limitsDb}
                        dbVersion={dbVersion}
                        timeRange={filters.range}
                        providers={visibleProviders}
                        accountFilter={filters.accounts ?? undefined}
                    />
                )}
                {extraTab ? <extraTab.View /> : null}
            </Box>
            <AlertBanner
                alerts={notifications?.alerts ?? []}
                onDismiss={() => {
                    notifications?.dismissAll();
                    forceUpdate((n) => n + 1);
                }}
            />
            <StatusBar
                lastRefresh={lastRefresh}
                nextRefresh={nextRefresh}
                paused={paused}
                pollingLabel={pollingLabel}
                pollInterval={pollInterval}
                sortMode={activeTab === "overview" ? sortMode : undefined}
            />
        </Box>
    );
}
