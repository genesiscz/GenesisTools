import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { NAV_ROUTES } from "@/lib/nav-routes";

export interface ShellTab {
    id: string;
    label: string;
    active: boolean;
    dot?: "active" | "idle";
    lastLine?: string;
}

export interface MobileTerminalShellProps {
    tabs: ShellTab[];
    /** Optional second strip row (cmux surface sub-tabs). */
    secondaryTabs?: ShellTab[];
    onSelect: (id: string) => void;
    onSelectSecondary?: (id: string) => void;
    onRename?: (id: string, name: string) => void;
    onRenameSecondary?: (id: string, name: string) => void;
    /** Icon buttons rendered before the primary action (e.g. tmux hub). */
    headerActions?: ReactNode;
    /** ＋ button (ttyd "new terminal"); omit to hide. */
    primaryAction?: { label: string; onClick: () => void };
    /** Per-tab content, all mounted; only the active one is visible (caller toggles via CSS). */
    children: ReactNode;
    /** Accordion preview renderer for a tab id (the shell caps it ≤50% screen). */
    renderPreview: (id: string) => ReactNode;
}

export function MobileTerminalShell(props: MobileTerminalShellProps) {
    const [navOpen, setNavOpen] = useState(false);
    const [overviewOpen, setOverviewOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const renderTab = (
        tab: ShellTab,
        onSelect: (id: string) => void,
        onRename?: (id: string, name: string) => void
    ) => {
        if (editingId === tab.id) {
            return (
                <input
                    key={tab.id}
                    autoFocus
                    defaultValue={tab.label}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            onRename?.(tab.id, e.currentTarget.value);
                            setEditingId(null);
                        }
                    }}
                    onBlur={() => setEditingId(null)}
                    className="dd-tab-edit"
                    aria-label={`rename ${tab.label}`}
                />
            );
        }

        return (
            <button
                key={tab.id}
                type="button"
                className={tab.active ? "dd-tab is-active" : "dd-tab"}
                onClick={() => {
                    if (tab.active && onRename) {
                        setEditingId(tab.id);
                    } else {
                        onSelect(tab.id);
                    }
                }}
                onDoubleClick={() => {
                    if (onRename) {
                        setEditingId(tab.id);
                    }
                }}
            >
                <span className="truncate">{tab.label}</span>
                {tab.active && onRename ? <span className="dd-tab-pen">✎</span> : null}
            </button>
        );
    };

    return (
        <div className="dd-focused grid h-full min-w-0 max-w-full grid-rows-[auto_1fr] overflow-hidden">
            <div className="dd-edge" aria-hidden />
            <button
                type="button"
                className="dd-edge-handle"
                aria-label="open navigation"
                onClick={() => setNavOpen(true)}
            >
                ›
            </button>

            <div className="dd-shell-chrome">
                <header className="dd-strip">
                    <div className="dd-strip-side dd-strip-side--start">
                        <button
                            type="button"
                            className="dd-burger"
                            aria-label="overview"
                            onClick={() => setOverviewOpen(true)}
                        >
                            ☰
                        </button>
                    </div>
                    <div className="dd-strip-scroll" role="tablist" aria-label="terminal tabs">
                        {props.tabs.map((t) => renderTab(t, props.onSelect, props.onRename))}
                    </div>
                    <div className="dd-strip-side dd-strip-side--end">
                        {props.headerActions ? (
                            <div className="dd-strip-actions">{props.headerActions}</div>
                        ) : null}
                        {props.primaryAction ? (
                            <button type="button" className="dd-plus" onClick={props.primaryAction.onClick}>
                                {props.primaryAction.label}
                            </button>
                        ) : null}
                    </div>
                </header>

                {props.secondaryTabs ? (
                    <div className="dd-subrow">
                        <div className="dd-subrow-gutter" aria-hidden />
                        <div className="dd-subrow-scroll" role="tablist" aria-label="surface tabs">
                            {props.secondaryTabs.map((t) =>
                                renderTab(t, props.onSelectSecondary ?? (() => {}), props.onRenameSecondary)
                            )}
                        </div>
                    </div>
                ) : null}
            </div>

            <div className="dd-shell-body">{props.children}</div>

            {navOpen ? (
                <div className="absolute inset-0 z-40 flex bg-black/55" onClick={() => setNavOpen(false)}>
                    <nav className="dd-nav-panel" onClick={(e) => e.stopPropagation()}>
                        {NAV_ROUTES.map(({ to, label, Icon, exact }) => (
                            <Link
                                key={to}
                                to={to}
                                onClick={() => setNavOpen(false)}
                                className="dd-nav-item flex items-center gap-3"
                                activeProps={{ className: "dd-nav-item active flex items-center gap-3" }}
                                activeOptions={{ exact }}
                            >
                                <Icon size={16} />
                                <span>{label}</span>
                            </Link>
                        ))}
                    </nav>
                </div>
            ) : null}

            {overviewOpen ? (
                <div className="absolute inset-0 z-40 bg-black/55" onClick={() => setOverviewOpen(false)}>
                    <div className="dd-sheet" onClick={(e) => e.stopPropagation()}>
                        {props.tabs.map((t) => (
                            <div key={t.id}>
                                <button
                                    type="button"
                                    className={expandedId === t.id ? "dd-acc is-open" : "dd-acc"}
                                    onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                                >
                                    <span className={t.dot === "active" ? "dd-dot" : "dd-dot is-off"} />
                                    <span className="truncate">{t.label}</span>
                                    <span className="ml-auto truncate text-[var(--dd-text-muted)]">
                                        {t.lastLine ?? ""}
                                    </span>
                                </button>
                                {expandedId === t.id ? (
                                    <div className="overflow-hidden" style={{ maxHeight: "50vh" }}>
                                        {props.renderPreview(t.id)}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
