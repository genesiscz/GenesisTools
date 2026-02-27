import { Box } from "ink";
import React, { useEffect, useState } from "react";
import {
    loadDashboardConfig,
    type UsageDashboardConfig,
} from "@app/claude/lib/usage/dashboard-config";
import { useUsagePoller } from "./hooks/use-usage-poller";
import { useTabNavigation } from "./hooks/use-tab-navigation";
import { useKeybindings } from "./hooks/use-keybindings";
import { TabBar } from "./components/tab-bar";
import { StatusBar } from "./components/status-bar";
import { AlertBanner } from "./components/alert-banner";
import { OverviewView } from "./components/overview/overview-view";
import { TimelineView } from "./components/timeline/timeline-view";
import { RatesView } from "./components/rates/rates-view";
import { HistoryView } from "./components/history/history-view";
import { HelpOverlay } from "./components/help-overlay";

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
    const { activeTab, tabs, activeIndex } = useTabNavigation(config.defaultTab);

    const { results, isPolling, lastRefresh, nextRefresh, db, notifications, forceRefresh } =
        useUsagePoller({ config, accountFilter, paused: false });

    const { paused, showHelp, setShowHelp } = useKeybindings({
        onForceRefresh: forceRefresh,
        onDismissAlert: () => notifications?.dismissAll(),
    });

    if (showHelp) {
        return <HelpOverlay onClose={() => setShowHelp(false)} />;
    }

    return (
        <Box flexDirection="column">
            <TabBar tabs={tabs} activeIndex={activeIndex} />
            {activeTab === "overview" && (
                <OverviewView results={results} db={db} config={config} />
            )}
            {activeTab === "timeline" && (
                <TimelineView db={db} results={results} config={config} />
            )}
            {activeTab === "rates" && <RatesView db={db} results={results} />}
            {activeTab === "history" && <HistoryView db={db} />}
            <AlertBanner
                alerts={notifications?.alerts ?? []}
                onDismiss={() => notifications?.dismissAll()}
            />
            <StatusBar
                lastRefresh={lastRefresh}
                nextRefresh={nextRefresh}
                paused={paused}
                isPolling={isPolling}
            />
        </Box>
    );
}
