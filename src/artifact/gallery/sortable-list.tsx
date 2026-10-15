import { type SortableItem, SortableList } from "@artifact/kit";
import { useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Interactive",
    title: "Sortable list",
    summary: "Reorder by dragging the grip or with the keyboard. Plain pointer events, no drag library.",
    components: ["SortableList"],
};

const PRIORITIES = ["Checkout flow", "Search filters", "Saved carts", "Order history", "Gift cards"];

export default function SortableListPage() {
    const [order, setOrder] = useState(PRIORITIES);
    const [lanes, setLanes] = useState(["Discovery", "Platform", "Client apps", "Operations"]);
    const items: SortableItem[] = order.map((name) => ({ id: name, content: name }));

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab to a grip. Space picks the item up, Up and Down move it, Space or Enter drops it, Escape puts it back. Each step is announced."
        >
            <Demo title="Priority order" note={order.join(", ")}>
                <SortableList label="Priorities" ordered items={items} onReorder={(ids) => setOrder(ids)} buttons />
            </Demo>
            <Demo title="Edge case: a pinned item, whole-row drag" note="Operations is disabled and never moves">
                <SortableList
                    label="Lanes"
                    handle="row"
                    items={lanes.map((name) => ({ id: name, content: name, disabled: name === "Operations" }))}
                    onReorder={(ids) => setLanes(ids)}
                />
            </Demo>
        </GalleryPage>
    );
}
