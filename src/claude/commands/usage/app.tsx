import { POLL_INTERVALS, type PollInterval } from "@app/claude/lib/usage/constants";
import { loadDashboardConfig, type UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { useTerminalSize } from "@app/utils/ink/hooks/use-terminal-size";
import { Box } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertBanner } from "./components/alert-banner";
import { HelpOverlay } from "./components/help-overlay";
import { HistoryView } from "./components/history/history-view";
import { OverviewView } from "./components/overview/overview-view";
import { RatesView } from "./components/rates/rates-view";
import { StatusBar } from "./components/status-bar";
import { TabBar } from "./components/tab-bar";
import { TimelineView } from "./components/timeline/timeline-view";
import { useKeybindings } from "./hooks/use-keybindings";
import { useTabNavigation } from "./hooks/use-tab-navigation";
import { useUsagePoller } from "./hooks/use-usage-poller";

interface AppProps {
    accountFilter?: string;
}

export function App({ accountFilter }: AppProps) {
    const [config, setConfig] = useState<UsageDashboardConfig | null>(null);

    useEffect(() => {
        loadDashboardConfig().then(setConfig);
    }, []);

    if (!config) {
        return null;
    }

    return <Dashboard config={config} accountFilter={accountFilter} />;
}

interface DashboardProps {
    config: UsageDashboardConfig;
    accountFilter?: string;
}

function Dashboard({ config, accountFilter }: DashboardProps) {
    useTerminalSize({ clearOnResize: true });
    const { activeTab, tabs, activeIndex } = useTabNavigation(config.defaultTab);

    const [pollInterval, setPollInterval] = useState<PollInterval>(
        (POLL_INTERVALS.includes(config.refreshInterval as PollInterval) ? config.refreshInterval : 10) as PollInterval
    );

    const [paused, setPaused] = useState(false);
    const [, forceUpdate] = useState(0);

    const cycleInterval = useCallback(() => {
        setPollInterval((current) => {
            const idx = POLL_INTERVALS.indexOf(current);
            return POLL_INTERVALS[(idx + 1) % POLL_INTERVALS.length];
        });
    }, []);

    const { results, pollingLabel, lastRefresh, nextRefresh, db, notifications, forceRefresh } = useUsagePoller({
        config,
        accountFilter,
        paused,
        pollIntervalSeconds: pollInterval,
    });

    const forceRefreshRef = useRef(forceRefresh);
    forceRefreshRef.current = forceRefresh;

    const { showHelp, setShowHelp } = useKeybindings({
        onForceRefresh: () => forceRefreshRef.current(),
        onDismissAlert: () => {
            notifications?.dismissAll();
            forceUpdate((n) => n + 1);
        },
        onCycleInterval: cycleInterval,
        onTogglePause: () => setPaused((p) => !p),
    });

    if (showHelp) {
        return <HelpOverlay onClose={() => setShowHelp(false)} />;
    }

    return (
        <Box flexDirection="column">
            <TabBar tabs={tabs} activeIndex={activeIndex} />
            {activeTab === "overview" && <OverviewView results={results} config={config} />}
            {activeTab === "timeline" && <TimelineView db={db} results={results} config={config} />}
            {activeTab === "rates" && <RatesView db={db} results={results} />}
            {activeTab === "history" && <HistoryView db={db} />}
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
            />
        </Box>
    );
}
