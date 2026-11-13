import { type ReactNode, useId, useState } from "react";
import { UML_MARK, type UmlMark } from "./uml-diagram";

export interface PropertyGridRow {
    label: string;
    value: string;
    /** Visual classifier picker indicator; use onPick to make it actionable. */
    picker?: boolean;
    onPick?: () => void;
    mark?: UmlMark;
    hint?: string;
}
export interface PropertyGridGroup {
    title: string;
    rows: PropertyGridRow[];
}
export interface PropertyGridProps {
    title?: string;
    tabs?: string[];
    groups: PropertyGridGroup[];
    /** Optional content per tab. Without it tabs are a static window header, matching exported property sheets. */
    tabGroups?: Record<string, PropertyGridGroup[]>;
    initialTab?: string;
    footer?: ReactNode;
}
export function PropertyGrid({
    title = "Properties",
    tabs = ["Attribute", "Tags"],
    groups,
    tabGroups,
    initialTab,
    footer,
}: PropertyGridProps) {
    const uid = useId();
    const [active, setActive] = useState(initialTab ?? tabs[0]);
    const current = tabGroups?.[active] ?? groups;
    return (
        <div className="border border-line bg-panel font-sans text-xs text-ink">
            <div className="bg-panel-2 px-2 py-1 text-[17px]">{title}</div>
            <div
                className="flex gap-3 border-b border-line bg-panel-2 px-2 py-1"
                role={tabGroups ? "tablist" : undefined}
                aria-label={tabGroups ? `${title} tabs` : undefined}
            >
                {tabs.map((tab, i) =>
                    tabGroups ? (
                        <button
                            key={tab}
                            id={`${uid}-tab-${i}`}
                            role="tab"
                            type="button"
                            aria-selected={active === tab}
                            aria-controls={`${uid}-panel`}
                            onClick={() => setActive(tab)}
                            className={active === tab ? "border-b-2 border-info text-ink" : "text-dim"}
                        >
                            {tab}
                        </button>
                    ) : (
                        <span key={tab} className={i === 0 ? "border-b-2 border-info text-ink" : "text-dim"}>
                            {tab}
                        </span>
                    )
                )}
            </div>
            <div
                id={`${uid}-panel`}
                role={tabGroups ? "tabpanel" : undefined}
                aria-labelledby={tabGroups ? `${uid}-tab-${tabs.indexOf(active)}` : undefined}
            >
                {current.map((group, gi) => (
                    <section key={`${gi}-${group.title}`} aria-label={group.title}>
                        <div className="flex items-center gap-1.5 bg-panel-2 px-1.5 py-0.5 font-bold">
                            <span aria-hidden="true" className="text-[9px]">
                                ◢
                            </span>
                            {group.title}
                        </div>
                        <dl className="m-0">
                            {group.rows.map((row, ri) => (
                                <div
                                    key={`${ri}-${row.label}`}
                                    className="grid grid-cols-[120px_minmax(0,1fr)] border-b border-line"
                                >
                                    <dt className="py-0.5 pl-5">{row.label}</dt>
                                    <dd className="m-0 flex flex-col py-0.5 pr-1.5">
                                        <span className="flex items-center gap-1">
                                            <span
                                                className={`min-h-[18px] flex-1 break-words px-1 ${row.mark ? "border-2 font-bold" : ""}`}
                                                style={
                                                    row.mark
                                                        ? { color: UML_MARK[row.mark], borderColor: UML_MARK[row.mark] }
                                                        : undefined
                                                }
                                            >
                                                {row.value}
                                                {row.mark ? <span className="sr-only"> ({row.mark})</span> : null}
                                            </span>
                                            {row.picker ? (
                                                row.onPick ? (
                                                    <button
                                                        type="button"
                                                        onClick={row.onPick}
                                                        aria-label={`Choose ${row.label}`}
                                                        className="border border-line bg-panel-2 px-1.5 text-[11px]"
                                                    >
                                                        …
                                                    </button>
                                                ) : (
                                                    <span
                                                        aria-hidden="true"
                                                        className="border border-line bg-panel-2 px-1.5 text-[11px]"
                                                    >
                                                        …
                                                    </span>
                                                )
                                            ) : null}
                                        </span>
                                        {row.hint ? (
                                            <span
                                                className="text-[11px]"
                                                style={{ color: row.mark ? UML_MARK[row.mark] : "var(--dim)" }}
                                            >
                                                {row.hint}
                                            </span>
                                        ) : null}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </section>
                ))}
            </div>
            {footer ? <div className="p-3">{footer}</div> : null}
        </div>
    );
}
