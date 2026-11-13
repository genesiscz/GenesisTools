import {
    CardGrid,
    SegmentedControl,
    type UmlConnectorKind,
    UmlDiagram,
    type UmlDiagramModel,
    UmlInspector,
    UmlWorkbench,
} from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Diagrams",
    title: "UML diagram",
    summary:
        "Typed model elements, UML connectors, selectable boxes and an inspector. Modern theme tokens or a classic modeling canvas.",
    components: ["UmlDiagram", "UmlInspector", "UmlWorkbench", "borderPoint", "orthogonal", "umlConnectorHead"],
};
const MODEL: UmlDiagramModel = {
    name: "Library request (proposal)",
    width: 1000,
    height: 500,
    elements: [
        {
            id: "request",
            kind: "class",
            name: "BorrowRequest",
            x: 370,
            y: 60,
            w: 240,
            stereotype: "request",
            tags: [{ name: "version", value: "2" }],
            explain: "A **request** groups the member, item and duration. Select another box to inspect its fields.",
            yaml: "BorrowRequest:\n  type: object",
        },
        {
            id: "key",
            kind: "primitiveType",
            name: "ItemKey",
            x: 40,
            y: 280,
            w: 190,
            mark: "new",
            attributes: [{ name: "type", type: "string", mark: "ok" }],
            explain: "A stable key, supplied as plain text.",
            yaml: "itemKey:\n  type: string",
        },
        {
            id: "member",
            kind: "dataType",
            name: "Member",
            x: 370,
            y: 280,
            w: 210,
            from: "Shared types",
            attributes: [
                { visibility: "-", name: "id", type: "string" },
                { name: "legacyId", type: "number", mark: "err" },
            ],
        },
        {
            id: "period",
            kind: "enumeration",
            name: "LoanPeriod",
            x: 700,
            y: 280,
            w: 210,
            literals: ["Short", "Standard", "Extended"],
            mark: "warn",
        },
        {
            id: "note",
            kind: "note",
            name: "Migration note",
            x: 650,
            y: 100,
            w: 280,
            text: "Use a stable string key.\nThe numeric key is being retired.",
        },
    ],
    connectors: [
        {
            id: "key-request",
            kind: "association",
            source: "key",
            target: "request",
            name: "item",
            sourceCard: "1",
            targetRole: "request",
            directed: true,
            mark: "new",
        },
        {
            id: "member-request",
            kind: "composition",
            source: "member",
            target: "request",
            sourceRole: "member",
            sourceCard: "1",
            targetCard: "0..*",
        },
        {
            id: "period-request",
            kind: "association",
            source: "period",
            target: "request",
            name: "duration",
            sourceCard: "0..1",
        },
        { id: "note-request", kind: "noteLink", source: "note", target: "request" },
    ],
};
const KINDS: UmlConnectorKind[] = [
    "association",
    "aggregation",
    "composition",
    "generalization",
    "realization",
    "dependency",
    "usage",
    "noteLink",
];
const HEADS: UmlDiagramModel = {
    name: "Connector notation",
    width: 1000,
    height: 1000,
    elements: KINDS.flatMap((kind, i) => [
        { id: `${kind}-a`, kind: "class" as const, name: "Source", x: 40, y: 50 + i * 115, w: 190 },
        { id: `${kind}-b`, kind: "interface" as const, name: "Target", x: 700, y: 50 + i * 115, w: 210 },
    ]),
    connectors: KINDS.map((kind) => ({
        id: kind,
        kind,
        source: `${kind}-a`,
        target: `${kind}-b`,
        name: kind,
        sourceRole: "source",
        sourceCard: "1",
        targetRole: "target",
        targetCard: "*",
    })),
};
export default function UmlDiagramPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab to a selectable element, then Enter or Space to inspect it. The look controls are keyboard buttons."
        >
            <UmlWorkbench initialSelected="request">
                {({ theme, setTheme, selected, setSelected }) => (
                    <Demo title="Diagram and inspector recipe">
                        <SegmentedControl
                            label="Diagram look"
                            value={theme}
                            onChange={(value) => setTheme(value === "classic" ? "classic" : "modern")}
                            options={[
                                { value: "modern", label: "Modern" },
                                { value: "classic", label: "Classic" },
                            ]}
                        />
                        <CardGrid columns={2}>
                            <UmlDiagram model={MODEL} theme={theme} selected={selected} onSelect={setSelected} />
                            <UmlInspector element={MODEL.elements.find((element) => element.id === selected)} />
                        </CardGrid>
                    </Demo>
                )}
            </UmlWorkbench>
            <Demo title="Every connector kind, role labels and multiplicities">
                <UmlDiagram model={HEADS} />
            </Demo>
            <Demo title="Classic canvas stays readable on either page theme">
                <UmlDiagram model={MODEL} theme="classic" />
            </Demo>
        </GalleryPage>
    );
}
