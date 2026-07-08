import { getConfig } from "@app/dev-dashboard/config";
import { startPolling } from "@app/dev-dashboard/lib/cmux/poller";
import { configureRetention, startPulsePolling } from "@app/dev-dashboard/lib/system/poller";
import { Router } from "@app/dev-dashboard/server/router";
import { attentionRoutes } from "@app/dev-dashboard/server/routes/attention";
import { boardsRoutes } from "@app/dev-dashboard/server/routes/boards";
import { boardsAnnotationsRoutes } from "@app/dev-dashboard/server/routes/boards-annotations";
import { boardsComposeRoutes } from "@app/dev-dashboard/server/routes/boards-compose";
import { boardsQuestionsRoutes } from "@app/dev-dashboard/server/routes/boards-questions";
import { boardsSetsRoutes } from "@app/dev-dashboard/server/routes/boards-sets";
import { boardsWorkRoutes } from "@app/dev-dashboard/server/routes/boards-work";
import { claudeRoutes } from "@app/dev-dashboard/server/routes/claude";
import { cmuxRoutes } from "@app/dev-dashboard/server/routes/cmux";
import { commandsRoutes } from "@app/dev-dashboard/server/routes/commands";
import { containersRoutes } from "@app/dev-dashboard/server/routes/containers";
import { daemonRoutes } from "@app/dev-dashboard/server/routes/daemon";
import { diskRoutes } from "@app/dev-dashboard/server/routes/disk";
import { e2eRoutes } from "@app/dev-dashboard/server/routes/e2e";
import { netRoutes } from "@app/dev-dashboard/server/routes/net";
import { obsidianRoutes } from "@app/dev-dashboard/server/routes/obsidian";
import { portsRoutes } from "@app/dev-dashboard/server/routes/ports";
import { processesRoutes } from "@app/dev-dashboard/server/routes/processes";
import { qaRoutes } from "@app/dev-dashboard/server/routes/qa";
import { shareRoutes } from "@app/dev-dashboard/server/routes/share";
import { systemRoutes } from "@app/dev-dashboard/server/routes/system";
import { timelineRoutes } from "@app/dev-dashboard/server/routes/timeline";
import { tmuxRoutes } from "@app/dev-dashboard/server/routes/tmux";
import { tmuxPresetsRoutes } from "@app/dev-dashboard/server/routes/tmux-presets";
import { todosRoutes } from "@app/dev-dashboard/server/routes/todos";
import { ttydRoutes } from "@app/dev-dashboard/server/routes/ttyd";
import { weatherRoutes } from "@app/dev-dashboard/server/routes/weather";
import { logger } from "@app/logger";

/** Assemble every feature registrar into one transport-neutral Router. */
export function createDashboardRouter(): Router {
    return new Router().addAll([
        // Static-prefix boards routes MUST precede boardsRoutes()'s /api/boards/:slug catch-all
        // (the router is first-match) — see plan §0.3.2 / Task 13.
        ...boardsSetsRoutes(),
        ...boardsWorkRoutes(),
        ...boardsAnnotationsRoutes(),
        ...boardsComposeRoutes(),
        ...boardsQuestionsRoutes(),
        ...boardsRoutes(),
        ...systemRoutes(),
        ...netRoutes(),
        ...tmuxRoutes(),
        ...tmuxPresetsRoutes(),
        ...ttydRoutes(),
        ...cmuxRoutes(),
        ...commandsRoutes(),
        ...weatherRoutes(),
        ...claudeRoutes(),
        ...daemonRoutes(),
        ...timelineRoutes(),
        ...containersRoutes(),
        ...diskRoutes(),
        ...portsRoutes(),
        ...processesRoutes(),
        ...qaRoutes(),
        ...attentionRoutes(),
        ...todosRoutes(),
        ...obsidianRoutes(),
        ...shareRoutes(),
        ...e2eRoutes(),
    ]);
}

let started = false;

/** Boots the background pollers exactly once. Replaces the module-load side
 * effects that previously lived in vite-middleware.ts. */
export async function startBackgroundServices(): Promise<void> {
    if (started) {
        return;
    }

    started = true;

    try {
        const { cmuxPollIntervalMs, pulse } = await getConfig();
        startPolling(cmuxPollIntervalMs);
        configureRetention(pulse.retentionHours);
        startPulsePolling(pulse.pollIntervalMs);
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: poller config load failed; using defaults");
        startPolling(2000);
        startPulsePolling(5000);
    }
}
