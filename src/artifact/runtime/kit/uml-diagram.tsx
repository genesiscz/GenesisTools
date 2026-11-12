import { type ReactNode, useId, useState } from "react";
import { Md } from "./md";
import { type BodyContent, Card, CodeBlock } from "./primitives";

export type UmlElementKind = "class" | "primitiveType" | "dataType" | "enumeration" | "interface" | "note";
export type UmlMark = "ok" | "err" | "warn" | "new";
export type UmlThemeName = "modern" | "classic";
export interface UmlAttribute {
    visibility?: "+" | "-" | "#" | "~";
    name: string;
    type: string;
    multiplicity?: string;
    classifier?: string;
    mark?: UmlMark;
}
export interface UmlTag {
    name: string;
    value: string;
}
export interface UmlElement {
    id: string;
    kind: UmlElementKind;
    name: string;
    stereotype?: string;
    from?: string;
    x: number;
    y: number;
    w: number;
    attributes?: UmlAttribute[];
    literals?: string[];
    tags?: UmlTag[];
    text?: string;
    mark?: UmlMark;
    explain?: string;
    yaml?: string;
}
export type UmlConnectorKind =
    | "association"
    | "aggregation"
    | "composition"
    | "generalization"
    | "realization"
    | "dependency"
    | "usage"
    | "noteLink";
export interface UmlPoint {
    x: number;
    y: number;
}
export interface UmlConnector {
    id: string;
    kind: UmlConnectorKind;
    source: string;
    /** Diamond, triangle or navigation arrow is placed at this end. */
    target: string;
    name?: string;
    stereotype?: string;
    sourceRole?: string;
    sourceCard?: string;
    targetRole?: string;
    targetCard?: string;
    directed?: boolean;
    mark?: UmlMark;
    via?: UmlPoint[];
    labelDx?: number;
    labelDy?: number;
}
export interface UmlDiagramModel {
    name: string;
    type?: string;
    width: number;
    height: number;
    elements: UmlElement[];
    connectors: UmlConnector[];
}
export interface UmlDiagramProps {
    model: UmlDiagramModel;
    theme?: UmlThemeName;
    /** Alias for theme, consistent with the other kit visual components. */
    look?: UmlThemeName;
    selected?: string;
    onSelect?: (id: string) => void;
}

export const UML_MARK: Record<UmlMark, string> = {
    ok: "var(--ok)",
    err: "var(--err)",
    warn: "var(--warn)",
    new: "var(--ok)",
};
const KEYWORDS: Record<UmlElementKind, string> = {
    class: "",
    primitiveType: "primitive",
    dataType: "dataType",
    enumeration: "enumeration",
    interface: "interface",
    note: "",
};
interface UmlPalette {
    paper: string;
    ink: string;
    border: string;
    line: string;
    shadow: string;
    fill: [string, string];
    enumeration: [string, string];
    note: string;
}
const PALETTES: Record<UmlThemeName, UmlPalette> = {
    modern: {
        paper: "var(--panel)",
        ink: "var(--text)",
        border: "var(--border-2)",
        line: "var(--text-2)",
        shadow: "var(--line)",
        fill: ["var(--panel-2)", "var(--panel)"],
        enumeration: ["var(--panel-2)", "color-mix(in srgb, var(--ok) 12%, var(--panel))"],
        note: "color-mix(in srgb, var(--warn) 10%, var(--panel))",
    },
    // Classic owns an opaque light canvas, so its ink stays readable in either page theme.
    classic: {
        paper: "#fefaef",
        ink: "#000000",
        border: "#000000",
        line: "#000000",
        shadow: "#c0bfbf",
        fill: ["#fbf1e2", "#e6dccd"],
        enumeration: ["#e9fbe3", "#c9f0be"],
        note: "#ffffe0",
    },
};
const CLASSIC_MARK: Record<UmlMark, string> = { ok: "#176a30", new: "#176a30", warn: "#805000", err: "#b11d27" };
function markColor(mark: UmlMark | undefined, theme: UmlThemeName, fallback: string): string {
    return mark ? (theme === "classic" ? CLASSIC_MARK : UML_MARK)[mark] : fallback;
}
function headerHeight(element: UmlElement): number {
    return 31 + (element.stereotype || KEYWORDS[element.kind] ? 16 : 0) + (element.from ? 14 : 0);
}
export function elementHeight(element: UmlElement): number {
    if (element.kind === "note") {
        return Math.max(40, (element.text ?? "").split("\n").length * 16 + 14);
    }

    const rows = element.kind === "enumeration" ? element.literals?.length : element.attributes?.length;
    return (
        headerHeight(element) +
        Math.max(1, rows ?? 0) * 16 +
        8 +
        (element.tags?.length ? (element.tags.length + 1) * 16 + 8 : 0) +
        (element.kind === "class" || element.kind === "interface" ? 12 : 0)
    );
}
export function attributeText(attribute: UmlAttribute): string {
    return `${attribute.name}: ${attribute.type}${attribute.multiplicity ? ` [${attribute.multiplicity}]` : ""}`;
}
function centre(element: UmlElement): UmlPoint {
    return { x: element.x + element.w / 2, y: element.y + elementHeight(element) / 2 };
}
/** Intersection of the ray from a box centre toward a point with its border. */
export function borderPoint(element: UmlElement, toward: UmlPoint): UmlPoint {
    const c = centre(element);
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    // A coincident target still gets a point on the border.
    if (dx === 0 && dy === 0) {
        return { x: element.x + element.w, y: c.y };
    }

    const factor = Math.min(
        dx === 0 ? Infinity : element.w / (2 * Math.abs(dx)),
        dy === 0 ? Infinity : elementHeight(element) / (2 * Math.abs(dy))
    );
    return { x: c.x + dx * factor, y: c.y + dy * factor };
}
/** Facing border points with right-angle bends; coordinates remain independent of the DOM. */
export function orthogonal(source: UmlElement, target: UmlElement): UmlPoint[] {
    const s = centre(source);
    const t = centre(target);
    const down = t.y > s.y;
    const verticalGap = down
        ? target.y - source.y - elementHeight(source)
        : source.y - target.y - elementHeight(target);
    if (verticalGap > 0) {
        const sy = down ? source.y + elementHeight(source) : source.y;
        const ty = down ? target.y : target.y + elementHeight(target);
        const left = Math.max(source.x, target.x);
        const right = Math.min(source.x + source.w, target.x + target.w);
        if (right - left > 30) {
            return [
                { x: (left + right) / 2, y: sy },
                { x: (left + right) / 2, y: ty },
            ];
        }

        const half = target.w / 2 - 10;
        const tx = t.x + Math.max(-half, Math.min(half, (s.x - t.x) / 4));
        const bend = sy + (ty - sy) * (0.35 + 0.3 * Math.min(1, Math.abs(s.x - tx) / 600));
        return [
            { x: s.x, y: sy },
            { x: s.x, y: bend },
            { x: tx, y: bend },
            { x: tx, y: ty },
        ];
    }

    const sx = t.x > s.x ? source.x + source.w : source.x;
    const tx = t.x > s.x ? target.x : target.x + target.w;
    return [
        { x: sx, y: s.y },
        { x: (sx + tx) / 2, y: s.y },
        { x: (sx + tx) / 2, y: t.y },
        { x: tx, y: t.y },
    ];
}
export interface UmlConnectorHead {
    shape: "none" | "arrow" | "diamond" | "triangle";
    filled: boolean;
    dash?: string;
}
/** UML head and line semantics, shared by drawing and layout tests. */
export function umlConnectorHead(connector: Pick<UmlConnector, "kind" | "directed">): UmlConnectorHead {
    const definitions: Record<UmlConnectorKind, UmlConnectorHead> = {
        association: { shape: connector.directed ? "arrow" : "none", filled: false },
        aggregation: { shape: "diamond", filled: false },
        composition: { shape: "diamond", filled: true },
        generalization: { shape: "triangle", filled: false },
        realization: { shape: "triangle", filled: false, dash: "6 4" },
        dependency: { shape: "arrow", filled: false, dash: "6 4" },
        usage: { shape: "arrow", filled: false, dash: "6 4" },
        noteLink: { shape: "none", filled: false, dash: "2 3" },
    };
    return definitions[connector.kind];
}
function ConnectorHead({
    head,
    tip,
    before,
    color,
    paper,
}: {
    head: UmlConnectorHead;
    tip: UmlPoint;
    before: UmlPoint;
    color: string;
    paper: string;
}) {
    const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
    const offset = (x: number, y: number) =>
        `${tip.x + x * Math.cos(angle) - y * Math.sin(angle)},${tip.y + x * Math.sin(angle) + y * Math.cos(angle)}`;
    if (head.shape === "none") {
        return null;
    }

    if (head.shape === "arrow") {
        return <polyline points={`${offset(-10, -5)} ${offset(0, 0)} ${offset(-10, 5)}`} fill="none" stroke={color} />;
    }

    const points =
        head.shape === "diamond"
            ? `${offset(0, 0)} ${offset(-8, -5)} ${offset(-16, 0)} ${offset(-8, 5)}`
            : `${offset(0, 0)} ${offset(-14, -8)} ${offset(-14, 8)}`;
    return <polygon points={points} fill={head.filled ? color : paper} stroke={color} />;
}
function UmlLine({
    connector,
    source,
    target,
    theme,
    palette,
}: {
    connector: UmlConnector;
    source: UmlElement;
    target: UmlElement;
    theme: UmlThemeName;
    palette: UmlPalette;
}) {
    const via = connector.via;
    const points = via?.length
        ? [borderPoint(source, via[0]), ...via, borderPoint(target, via[via.length - 1])]
        : orthogonal(source, target);
    const start = points[0];
    const end = points[points.length - 1];
    const before = points[points.length - 2];
    const color = markColor(connector.mark, theme, palette.line);
    const head = umlConnectorHead(connector);
    const middle = Math.floor((points.length - 1) / 2);
    const mx = (points[middle].x + points[middle + 1].x) / 2 + (connector.labelDx ?? 0);
    const my = (points[middle].y + points[middle + 1].y) / 2 + (connector.labelDy ?? 0);
    const stereotype =
        connector.stereotype ??
        (connector.kind === "realization" ? "realize" : connector.kind === "usage" ? "use" : "");
    const labels = [connector.name, stereotype ? `«${stereotype}»` : undefined].filter(Boolean);
    return (
        <g data-uml-connector={connector.id}>
            <polyline
                points={points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={connector.mark ? 2 : 1}
                strokeDasharray={head.dash}
            />
            <ConnectorHead head={head} tip={end} before={before} color={color} paper={palette.paper} />
            {labels.map((label, i) => (
                <text
                    key={`${i}-${label}`}
                    x={mx + 6}
                    y={my - 4 + i * 13}
                    fontSize={11}
                    fill={color}
                    fontWeight={connector.mark ? 700 : 400}
                >
                    {label}
                </text>
            ))}
            {[
                { point: start, next: points[1], fraction: 0.2, labels: [connector.sourceRole, connector.sourceCard] },
                { point: end, next: before, fraction: 0.25, labels: [connector.targetRole, connector.targetCard] },
            ].map((side, i) =>
                side.labels.filter(Boolean).map((label, j) => (
                    <text
                        key={`${i}-${j}`}
                        x={side.point.x + (side.next.x - side.point.x) * side.fraction + 6}
                        y={side.point.y + (side.next.y - side.point.y) * side.fraction + 4 + j * 13}
                        fontSize={11}
                        fill={palette.ink}
                    >
                        {label}
                    </text>
                ))
            )}
        </g>
    );
}
function UmlBox({
    element,
    palette,
    theme,
    prefix,
    selected,
    onSelect,
}: {
    element: UmlElement;
    palette: UmlPalette;
    theme: UmlThemeName;
    prefix: string;
    selected: boolean;
    onSelect?: (id: string) => void;
}) {
    const { x, y, w } = element;
    const h = elementHeight(element);
    const border = markColor(element.mark, theme, palette.border);
    const keyword = [KEYWORDS[element.kind], element.stereotype].filter(Boolean).join(", ");
    const body = y + headerHeight(element);
    const rows =
        element.kind === "enumeration"
            ? (element.literals ?? []).map((name) => ({ name, text: name, visibility: "", mark: undefined }))
            : (element.attributes ?? []).map((attribute) => ({
                  name: attribute.name,
                  text: attributeText(attribute),
                  visibility: attribute.visibility ?? "+",
                  mark: attribute.mark,
              }));
    const bottom = body + Math.max(1, rows.length) * 16 + 8;
    const choose = () => onSelect?.(element.id);
    return (
        <g
            data-uml-element={element.id}
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            aria-label={onSelect ? element.name : undefined}
            aria-pressed={onSelect ? selected : undefined}
            onClick={choose}
            onKeyDown={
                onSelect
                    ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              choose();
                          }
                      }
                    : undefined
            }
            className={onSelect ? "cursor-pointer focus-visible:outline-2 focus-visible:outline-info" : undefined}
        >
            <title>{`${element.name || element.kind}${element.mark ? ` (${element.mark})` : ""}`}</title>
            {selected ? (
                <rect
                    x={x - 4}
                    y={y - 4}
                    width={w + 8}
                    height={h + 8}
                    fill="none"
                    stroke={theme === "classic" ? "#2456a6" : "var(--info)"}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                />
            ) : null}
            {element.kind === "note" ? (
                <>
                    <path
                        d={`M${x} ${y} h${w - 10} l10 10 v${h - 10} h${-w} z`}
                        fill={palette.note}
                        stroke={border}
                        strokeWidth={element.mark ? 2 : 1}
                    />
                    <path d={`M${x + w - 10} ${y} v10 h10`} fill="none" stroke={border} />
                    {(element.text ?? "").split("\n").map((line, i) => (
                        <text key={`${i}-${line}`} x={x + 7} y={y + 18 + i * 16} fill={palette.ink} fontSize={11}>
                            {line}
                        </text>
                    ))}
                </>
            ) : (
                <>
                    <rect x={x + 3} y={y + 3} width={w} height={h} fill={palette.shadow} />
                    <rect
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        fill={`url(#${prefix}-${element.kind})`}
                        stroke={border}
                        strokeWidth={element.mark ? 2 : 1}
                    />
                    {keyword ? (
                        <text
                            x={x + w / 2}
                            y={y + 20}
                            textAnchor="middle"
                            fontSize={11}
                            fill={palette.ink}
                        >{`«${keyword}»`}</text>
                    ) : null}
                    <text
                        x={x + w / 2}
                        y={y + (keyword ? 37 : 21)}
                        textAnchor="middle"
                        fontSize={12}
                        fontWeight={700}
                        fill={palette.ink}
                    >
                        {element.name}
                    </text>
                    {element.from ? (
                        <text
                            x={x + w / 2}
                            y={body - 10}
                            textAnchor="middle"
                            fontSize={10}
                            fontStyle="italic"
                            fill={palette.ink}
                        >{`(from ${element.from})`}</text>
                    ) : null}
                    <line x1={x} x2={x + w} y1={body} y2={body} stroke={palette.border} />
                    {rows.map((row, i) => (
                        <g key={`${i}-${row.name}`}>
                            <text x={x + 7} y={body + 13 + i * 16} fontSize={11} fill={palette.ink}>
                                {row.visibility}
                            </text>
                            <text
                                x={x + 21}
                                y={body + 13 + i * 16}
                                fontSize={11}
                                fill={markColor(row.mark, theme, palette.ink)}
                                fontWeight={row.mark ? 700 : 400}
                            >
                                {row.text}
                            </text>
                        </g>
                    ))}
                    {element.tags?.length ? (
                        <g>
                            <line x1={x} x2={x + w} y1={bottom} y2={bottom} stroke={palette.border} />
                            <text
                                x={x + w / 2}
                                y={bottom + 13}
                                textAnchor="middle"
                                fontSize={11}
                                fontStyle="italic"
                                fill={palette.ink}
                            >
                                tags
                            </text>
                            {element.tags.map((tag, i) => (
                                <text
                                    key={`${i}-${tag.name}`}
                                    x={x + 7}
                                    y={bottom + 29 + i * 16}
                                    fontSize={11}
                                    fill={palette.ink}
                                >{`${tag.name} = ${tag.value}`}</text>
                            ))}
                        </g>
                    ) : null}
                    {element.kind === "class" || element.kind === "interface" ? (
                        <line x1={x} x2={x + w} y1={y + h - 12} y2={y + h - 12} stroke={palette.border} />
                    ) : null}
                </>
            )}
        </g>
    );
}
export function UmlDiagram({ model, theme = "modern", look, selected, onSelect }: UmlDiagramProps) {
    const appearance = look ?? theme;
    const palette = PALETTES[appearance];
    const prefix = `uml-${useId().replace(/:/g, "")}`;
    const elements = new Map(model.elements.map((element) => [element.id, element]));
    const tab = `${model.type ?? "class"} ${model.name}`;
    return (
        <svg
            viewBox={`0 0 ${model.width} ${model.height}`}
            width="100%"
            role={onSelect ? "group" : "img"}
            aria-label={`UML diagram ${model.name}`}
            className="block rounded border border-line"
            style={{
                fontFamily:
                    appearance === "classic"
                        ? "Tahoma, Arial, sans-serif"
                        : "'Segoe UI', Tahoma, Verdana, Arial, sans-serif",
                background: palette.paper,
            }}
        >
            <title>{tab}</title>
            <defs>
                {(Object.keys(KEYWORDS) as UmlElementKind[]).map((kind) => {
                    const fill =
                        kind === "enumeration"
                            ? palette.enumeration
                            : kind === "note"
                              ? [palette.note, palette.note]
                              : palette.fill;
                    return (
                        <linearGradient key={kind} id={`${prefix}-${kind}`} x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0" stopColor={fill[0]} />
                            <stop offset="1" stopColor={fill[1]} />
                        </linearGradient>
                    );
                })}
            </defs>
            <rect x={8} y={8} width={model.width - 16} height={model.height - 16} fill="none" stroke={palette.ink} />
            <path d={`M8 8 h${tab.length * 6.6 + 24} v12 l-8 8 H8 z`} fill={palette.paper} stroke={palette.ink} />
            <text x={14} y={23} fontSize={12} fontWeight={700} fill={palette.ink}>
                {tab}
            </text>
            {model.connectors.map((connector) => {
                const source = elements.get(connector.source);
                const target = elements.get(connector.target);
                return source && target ? (
                    <UmlLine
                        key={connector.id}
                        connector={connector}
                        source={source}
                        target={target}
                        theme={appearance}
                        palette={palette}
                    />
                ) : null;
            })}
            {model.elements.map((element) => (
                <UmlBox
                    key={element.id}
                    element={element}
                    palette={palette}
                    theme={appearance}
                    prefix={prefix}
                    selected={selected === element.id}
                    onSelect={onSelect}
                />
            ))}
        </svg>
    );
}

export interface UmlInspectorProps {
    element?: UmlElement;
    emptyTitle?: string;
    emptyBody?: BodyContent;
    kicker?: string;
    labels?: { kind?: string; stereotype?: string; attributes?: string; tags?: string };
    codeLabel?: string;
    codeLang?: string;
}
export function UmlInspector({
    element,
    emptyTitle = "Select an element",
    emptyBody = "Select a box to inspect its properties and generated output.",
    kicker = "Element properties",
    labels,
    codeLabel = "Generated output",
    codeLang = "yaml",
}: UmlInspectorProps) {
    if (!element) {
        return (
            <Card title={emptyTitle} edge="none">
                {emptyBody}
            </Card>
        );
    }

    const fields = [
        { k: labels?.kind ?? "Element kind", v: element.kind },
        ...(element.stereotype ? [{ k: labels?.stereotype ?? "Stereotype", v: element.stereotype }] : []),
        ...(element.attributes?.length
            ? [{ k: labels?.attributes ?? "Attributes", v: element.attributes.map(attributeText).join(", ") }]
            : []),
        ...(element.tags?.length
            ? [{ k: labels?.tags ?? "Tags", v: element.tags.map((tag) => `${tag.name} = ${tag.value}`).join(", ") }]
            : []),
    ];
    return (
        <Card title={element.name} kicker={kicker} fields={fields} edge="none">
            {element.explain ? <Md>{element.explain}</Md> : null}
            {element.yaml ? (
                <CodeBlock lang={codeLang} label={codeLabel} wrap>
                    {element.yaml}
                </CodeBlock>
            ) : null}
        </Card>
    );
}
export interface UmlWorkbenchState {
    state: string;
    setState: (value: string) => void;
    theme: UmlThemeName;
    setTheme: (value: UmlThemeName) => void;
    selected: string;
    setSelected: (value: string) => void;
    operationSelected: string;
    setOperationSelected: (value: string) => void;
}
export interface UmlWorkbenchProps {
    initialState?: string;
    initialTheme?: UmlThemeName;
    initialSelected?: string;
    initialOperationSelected?: string;
    children: (state: UmlWorkbenchState) => ReactNode;
}
/** Own selection and view controls when a page combines multiple diagrams and inspectors. */
export function UmlWorkbench({
    initialState = "today",
    initialTheme = "modern",
    initialSelected = "",
    initialOperationSelected = "",
    children,
}: UmlWorkbenchProps) {
    const [state, setState] = useState(initialState);
    const [theme, setTheme] = useState(initialTheme);
    const [selected, setSelected] = useState(initialSelected);
    const [operationSelected, setOperationSelected] = useState(initialOperationSelected);
    return children({
        state,
        setState,
        theme,
        setTheme,
        selected,
        setSelected,
        operationSelected,
        setOperationSelected,
    });
}
