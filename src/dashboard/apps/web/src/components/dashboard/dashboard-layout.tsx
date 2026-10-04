import { AppShell } from "@ui/custom";
import { useDashboardTheme } from "@ui/theme/dashboard-theme";
import { useSettings } from "@/lib/hooks/useSettings";
import { AppSidebar } from "./app-sidebar";

interface DashboardLayoutProps {
    children: React.ReactNode;
    title?: string;
    description?: string;
}

export function DashboardLayout({ children, title, description }: DashboardLayoutProps) {
    const { settings } = useSettings();
    const { className } = useDashboardTheme("personal-dashboard");

    return (
        <AppShell
            sidebar={<AppSidebar />}
            title={title}
            description={description}
            gridBackground={settings.gridBackground}
            scanLinesEffect={settings.scanLinesEffect}
            themeClass={className || undefined}
            themeKey="personal-dashboard"
        >
            {children}
        </AppShell>
    );
}
