import {
    Activity,
    BookOpen,
    Bot,
    Boxes,
    Container,
    ListTodo,
    MessageCircleQuestion,
    TerminalSquare,
    Timer,
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
    { to: "/claude", label: "claude usage", Icon: Bot },
    { to: "/daemon", label: "daemon", Icon: Timer },
    { to: "/containers", label: "containers", Icon: Container },
    { to: "/todos", label: "todos", Icon: ListTodo },
    { to: "/qa", label: "Q&A", Icon: MessageCircleQuestion },
    { to: "/ttyd", label: "ttyd", Icon: TerminalSquare },
    { to: "/cmux", label: "cmux", Icon: Boxes },
    { to: "/obsidian", label: "obsidian", Icon: BookOpen },
];
