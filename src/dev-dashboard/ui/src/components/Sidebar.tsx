import { Link, useLocation } from "@tanstack/react-router";
import { Activity, BookOpen, Bot, Boxes, Container, ListTodo, TerminalSquare, Timer } from "lucide-react";
import type { ComponentType } from "react";

interface Item {
    to: string;
    label: string;
    Icon: ComponentType<{ size?: number }>;
    exact?: boolean;
}

const ITEMS: Item[] = [
    { to: "/", label: "pulse", Icon: Activity, exact: true },
    { to: "/claude", label: "claude usage", Icon: Bot },
    { to: "/daemon", label: "daemon", Icon: Timer },
    { to: "/containers", label: "containers", Icon: Container },
    { to: "/todos", label: "todos", Icon: ListTodo },
    { to: "/ttyd", label: "ttyd", Icon: TerminalSquare },
    { to: "/cmux", label: "cmux", Icon: Boxes },
    { to: "/obsidian", label: "obsidian", Icon: BookOpen },
];

export function Sidebar() {
    const { pathname } = useLocation();

    return (
        <nav className="flex flex-col items-center gap-3 pt-4">
            <div
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px]"
                style={{ background: "var(--dd-accent-gradient)", boxShadow: "0 0 14px rgba(52,211,153,0.35)" }}
                aria-label="dev-dashboard"
            />
            {ITEMS.map(({ to, label, Icon, exact }) => {
                const active = exact ? pathname === to : pathname.startsWith(to);

                return (
                    <Link
                        key={to}
                        to={to}
                        title={label}
                        aria-label={label}
                        className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] border transition"
                        style={{
                            background: active ? "var(--dd-accent-gradient)" : "transparent",
                            borderColor: active ? "transparent" : "var(--dd-border)",
                            color: active ? "#0c0e10" : "var(--dd-text-secondary)",
                        }}
                    >
                        <Icon size={14} />
                    </Link>
                );
            })}
        </nav>
    );
}
