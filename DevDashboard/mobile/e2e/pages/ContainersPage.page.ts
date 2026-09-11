import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Containers screen (plan 09). Locates by the `testID`s baked into the screen +
 * its components (accessibility-id via the `~` selector in BasePage).
 */
class ContainersPage extends BasePage {
    private readonly ids = {
        screen: "screen-containers",
        loading: "containers-loading",
        dockerUnavailable: "containers-docker-unavailable",
        empty: "containers-empty",
        running: "containers-running",
        stopped: "containers-stopped",
    } as const;

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    /** One of: docker-unavailable card, empty state, a running section, or a stopped section. */
    async hasContentOrState(): Promise<boolean> {
        for (const id of [this.ids.dockerUnavailable, this.ids.empty, this.ids.running, this.ids.stopped]) {
            if (await this.byId(id).isExisting()) {
                return true;
            }
        }

        return false;
    }

    async isDockerUnavailableShown(): Promise<boolean> {
        return this.byId(this.ids.dockerUnavailable).isExisting();
    }

    /**
     * At least one of the running / stopped sections (or the empty state) is present — i.e. Docker is
     * reachable and the screen rendered its container inventory. Use after gating on
     * `isDockerUnavailableShown()` so a Docker-less Agent doesn't hard-fail.
     */
    async hasRunningOrStopped(): Promise<boolean> {
        for (const id of [this.ids.running, this.ids.stopped, this.ids.empty]) {
            if (await this.byId(id).isExisting()) {
                return true;
            }
        }

        return false;
    }

    rowId(containerId: string): string {
        return `container-row-${containerId}`;
    }

    stateId(containerId: string): string {
        return `container-state-${containerId}`;
    }
}

export const containersPage = new ContainersPage();
