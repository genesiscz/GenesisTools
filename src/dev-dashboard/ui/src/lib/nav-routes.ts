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
    Presentation,
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
    // Original features — kept in their pre-port order.
    { to: "/", label: "pulse", Icon: Activity, exact: true },
    { to: "/claude", label: "claude usage", Icon: Bot },
    { to: "/daemon", label: "daemon", Icon: Timer },
    { to: "/containers", label: "containers", Icon: Container },
    { to: "/todos", label: "todos", Icon: ListTodo },
    { to: "/qa", label: "Q&A", Icon: MessageCircleQuestion },
    { to: "/ttyd", label: "ttyd", Icon: TerminalSquare },
    { to: "/cmux", label: "cmux", Icon: Boxes },
    { to: "/obsidian", label: "obsidian", Icon: BookOpen },
    // New features (ported from the mobile dev-dashboard) — appended at the bottom.
    { to: "/boards", label: "boards", Icon: Presentation },
    { to: "/needs-input-inbox", label: "needs input", Icon: Inbox },
    { to: "/network-status", label: "network", Icon: Wifi },
    { to: "/build-log-tail", label: "build log", Icon: ScrollText },
    { to: "/activity-timeline", label: "activity", Icon: History },
    { to: "/disk-janitor", label: "disk janitor", Icon: HardDrive },
    { to: "/port-killer", label: "port killer", Icon: Crosshair },
    { to: "/process-monitor", label: "processes", Icon: Gauge },
    { to: "/tmux-presets", label: "tmux presets", Icon: Save },
    { to: "/quick-commands", label: "quick commands", Icon: SquareTerminal },
];
