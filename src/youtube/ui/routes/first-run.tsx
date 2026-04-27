import { createFileRoute, redirect } from "@tanstack/react-router";
import { FirstRunWizard } from "@app/yt/components/first-run/first-run-wizard";
import { fetchUiConfig } from "@app/yt/config.client";

export const Route = createFileRoute("/first-run")({
    beforeLoad: async () => {
        const { config } = await fetchUiConfig();

        if (config.firstRunComplete) {
            throw redirect({ to: "/" });
        }
    },
    component: FirstRunWizard,
});
