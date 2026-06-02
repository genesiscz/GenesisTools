import {
    Activity,
    BookOpen,
    Bot,
    Boxes,
    Container,
    Crosshair,
    Gauge,
    HardDrive,
    History,
    Inbox,
    ListTodo,
    MessageCircleQuestion,
    Save,
    ScrollText,
    SquareTerminal,
    TerminalSquare,
    Timer,
    Wifi,
} from "lucide-react";
import type { ComponentType } from "react";

export interface NavRoute {
    to: string;
    label: string;
    Icon: ComponentType<{ size?: number }>;
    exact?: boolean;
}

// Single source of truth for the dashboard's nav. Consumed by the desktop
// Sidebar rail and the mobile/focused nav overlay so they never drift.
export const NAV_ROUTES: NavRoute[] = [
    { to: "/", label: "pulse", Icon: Activity, exact: true },
    { to: "/needs-input-inbox", label: "needs input", Icon: Inbox },
    { to: "/network-status", label: "network", Icon: Wifi },
    { to: "/claude", label: "claude usage", Icon: Bot },
    { to: "/daemon", label: "daemon", Icon: Timer },
    { to: "/build-log-tail", label: "build log", Icon: ScrollText },
    { to: "/activity-timeline", label: "activity", Icon: History },
    { to: "/containers", label: "containers", Icon: Container },
    { to: "/disk-janitor", label: "disk janitor", Icon: HardDrive },
    { to: "/port-killer", label: "port killer", Icon: Crosshair },
    { to: "/process-monitor", label: "processes", Icon: Gauge },
    { to: "/todos", label: "todos", Icon: ListTodo },
    { to: "/qa", label: "Q&A", Icon: MessageCircleQuestion },
    { to: "/tmux-presets", label: "tmux presets", Icon: Save },
    { to: "/quick-commands", label: "quick commands", Icon: SquareTerminal },
    { to: "/ttyd", label: "ttyd", Icon: TerminalSquare },
    { to: "/cmux", label: "cmux", Icon: Boxes },
    { to: "/obsidian", label: "obsidian", Icon: BookOpen },
];
