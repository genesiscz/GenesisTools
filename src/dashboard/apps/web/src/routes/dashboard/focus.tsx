import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { FocusHero } from "./-focus/FocusHero";

export const Route = createFileRoute("/dashboard/focus")({
    component: FocusModePage,
});

function FocusModePage() {
    return (
        <DashboardLayout
            title="Focus Mode"
            description="Deep work sessions with Pomodoro technique"
        >
            <FocusHero />
        </DashboardLayout>
    );
}
