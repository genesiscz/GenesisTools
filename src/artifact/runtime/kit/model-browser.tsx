import { type ReactNode, useState } from "react";
import { UML_MARK, type UmlMark } from "./uml-diagram";

export type ModelBrowserIcon =
    | "package"
    | "class"
    | "primitiveType"
    | "dataType"
    | "enumeration"
    | "interface"
    | "method"
    | "request"
    | "response"
    | "diagram"
    | "attribute";
export interface ModelBrowserNode {
    id?: string;
    name: string;
    icon: ModelBrowserIcon;
    stereotype?: string;
    mark?: UmlMark;
    note?: string;
    children?: ModelBrowserNode[];
    open?: boolean;
}
export interface ModelBrowserProps {
    root: ModelBrowserNode[];
    title?: string;
    tabs?: string[];
    selected?: string;
    onSelect?: (id: string, node: ModelBrowserNode) => void;
}
function ModelIcon({ icon }: { icon: ModelBrowserIcon }) {
    const accent =
        icon === "package" || icon === "diagram" ? "var(--warn)" : icon === "method" ? "var(--accent)" : "var(--info)";
    return (
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true" className="shrink-0">
            {icon === "package" ? (
                <path d="M1 3 h5 l1.5 2 H15 v8 H1 z" fill="var(--panel-2)" stroke={accent} />
            ) : icon === "interface" ? (
                <circle cx="8" cy="7" r="5" fill="var(--panel)" stroke={accent} />
            ) : (
                <>
                    <rect x="1.5" y="1.5" width="13" height="11" fill="var(--panel)" stroke={accent} />
                    {icon === "diagram" ? (
                        <rect x="4" y="4" width="8" height="6" fill="var(--info)" />
                    ) : (
                        <>
                            <line x1="1.5" x2="14.5" y1="5" y2="5" stroke={accent} />
                            {icon === "primitiveType" || icon === "attribute" ? (
                                <text x="8" y="11.5" fontSize="6" textAnchor="middle" fill={accent}>
                                    {icon === "primitiveType" ? "P" : "+"}
                                </text>
                            ) : (
                                <line x1="1.5" x2="14.5" y1="9" y2="9" stroke={accent} />
                            )}
                        </>
                    )}
                </>
            )}
        </svg>
    );
}
function BrowserRow({
    node,
    selected,
    onSelect,
}: Pick<ModelBrowserProps, "selected" | "onSelect"> & { node: ModelBrowserNode }) {
    const [open, setOpen] = useState(node.open ?? true);
    const nested = Boolean(node.children?.length);
    const id = node.id ?? node.name;
    const label: ReactNode = (
        <>
            <ModelIcon icon={node.icon} />
            <span
                style={
                    node.mark
                        ? {
                              color: UML_MARK[node.mark],
                              fontWeight: 700,
                              textDecoration: node.mark === "err" ? "line-through" : undefined,
                          }
                        : undefined
                }
            >
                {node.stereotype ? `«${node.stereotype}» ` : ""}
                {node.name}
            </span>
            {node.mark ? <span className="sr-only">{node.mark}</span> : null}
            {node.note ? (
                <span className="ml-1.5 text-[11px]" style={{ color: node.mark ? UML_MARK[node.mark] : "var(--dim)" }}>
                    {node.note}
                </span>
            ) : null}
        </>
    );
    const select = () => onSelect?.(id, node);
    return (
        <li className="list-none">
            <div
                className={`flex min-h-5 items-center gap-1.5 whitespace-nowrap ${selected === id ? "bg-info/10" : ""}`}
            >
                {nested ? (
                    <button
                        type="button"
                        aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                        className="w-3 shrink-0 text-[9px] focus-visible:outline-2 focus-visible:outline-info"
                    >
                        {open ? "◢" : "▷"}
                    </button>
                ) : (
                    <span className="w-3 shrink-0" />
                )}
                {onSelect ? (
                    <button
                        type="button"
                        onClick={select}
                        aria-pressed={selected === id}
                        className="flex items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-info"
                    >
                        {label}
                    </button>
                ) : nested ? (
                    <button
                        type="button"
                        onClick={() => setOpen(!open)}
                        aria-expanded={open}
                        className="flex items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-info"
                    >
                        {label}
                    </button>
                ) : (
                    <span className="flex items-center gap-1.5">{label}</span>
                )}
            </div>
            {nested && open ? (
                <ul className="m-0 border-l border-line p-0 pl-5">
                    {node.children?.map((child, i) => (
                        <BrowserRow
                            key={child.id ?? `${i}-${child.name}`}
                            node={child}
                            selected={selected}
                            onSelect={onSelect}
                        />
                    ))}
                </ul>
            ) : null}
        </li>
    );
}
/** A compact model tree; each branch owns its expansion state and preserves model ordering. */
export function ModelBrowser({
    root,
    title = "Browser",
    tabs = ["Project", "Context", "Diagram", "Resources"],
    selected,
    onSelect,
}: ModelBrowserProps) {
    return (
        <div className="overflow-auto border border-line bg-panel font-sans text-xs text-ink">
            <div className="flex items-center justify-between bg-panel-2 px-2 py-1 text-[15px]">
                <span>{title}</span>
            </div>
            <div className="flex gap-3 border-b border-line bg-panel-2 px-2 py-1">
                {tabs.map((tab, i) => (
                    <span key={tab} className={i === 0 ? "border-b-2 border-info text-ink" : "text-dim"}>
                        {tab}
                    </span>
                ))}
            </div>
            <ul aria-label={title} className="m-0 px-1 py-1.5">
                {root.map((node, i) => (
                    <BrowserRow
                        key={node.id ?? `${i}-${node.name}`}
                        node={node}
                        selected={selected}
                        onSelect={onSelect}
                    />
                ))}
            </ul>
        </div>
    );
}
