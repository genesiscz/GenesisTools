import { AppShell } from "@ui/custom";
import { useSettings } from "@/lib/hooks/useSettings";
import { AppSidebar } from "./app-sidebar";

interface DashboardLayoutProps {
    children: React.ReactNode;
    title?: string;
    description?: string;
}

export function DashboardLayout({ children, title, description }: DashboardLayoutProps) {
    const { settings } = useSettings();

    return (
        <AppShell
            sidebar={<AppSidebar />}
            title={title}
            description={description}
            gridBackground={settings.gridBackground}
            scanLinesEffect={settings.scanLinesEffect}
        >
            {children}
        </AppShell>
    );
}
