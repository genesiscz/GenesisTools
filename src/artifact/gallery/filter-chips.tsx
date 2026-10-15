import { FilterChips, SERIES_COLOR } from "@artifact/kit";
import { useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    title: "Filter chips",
    summary: "Toggle chips with aria-pressed, a colour swatch, counts, and All and None.",
};

const LANES = ["Discovery", "Platform", "Client apps", "Data", "Quality", "Operations", "Design", "Support"];

export default function FilterChipsPage() {
    const [value, setValue] = useState(["Discovery", "Platform", "Client apps"]);

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab walks the chips; Space or Enter toggles one. A polite live region says how many are shown."
        >
            <Demo title="Controlled, with bulk buttons" note={`${value.length} shown`}>
                <FilterChips
                    label="Lanes"
                    bulk
                    value={value}
                    onChange={setValue}
                    items={LANES.map((l, i) => ({ id: l, label: l, color: SERIES_COLOR[i], count: ((i * 3) % 7) + 1 }))}
                />
            </Demo>
            <Demo title="Edge case: a disabled chip" note="All and None leave it alone">
                <FilterChips
                    label="States"
                    bulk
                    items={[
                        { id: "open", label: "Open" },
                        { id: "active", label: "Active" },
                        { id: "archived", label: "Archived", disabled: true },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
