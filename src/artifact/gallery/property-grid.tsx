import { PropertyGrid, type PropertyGridGroup } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";
export const meta: GalleryMeta = {
    family: "Data",
    title: "Property grid",
    summary: "Grouped model properties, row marks, optional tab content and a footer.",
    components: ["PropertyGrid"],
};
const GROUPS: PropertyGridGroup[] = [
    {
        title: "Attribute",
        rows: [
            { label: "Name", value: "itemKey" },
            { label: "Type", value: "string", mark: "ok", hint: "Plain text with no classifier", picker: true },
            { label: "Legacy type", value: "integer", mark: "err", hint: "Retired" },
            { label: "Multiplicity", value: "1", mark: "warn", hint: "Confirm requiredness" },
        ],
    },
];
export default function PropertyGridPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="When tab content is supplied, Tab reaches every tab and Enter selects it. The property rows use definition lists for reading."
        >
            <Demo title="A property sheet with marks and a footer">
                <PropertyGrid groups={GROUPS} footer="A marked field needs review before the model is published." />
            </Demo>
            <Demo title="Tabs with distinct content">
                <PropertyGrid
                    groups={GROUPS}
                    tabGroups={{
                        Attribute: GROUPS,
                        Tags: [{ title: "Tags", rows: [{ label: "version", value: "2", mark: "new" }] }],
                    }}
                />
            </Demo>
            <Demo title="Edge case: an empty sheet">
                <PropertyGrid tabs={[]} groups={[]} />
            </Demo>
        </GalleryPage>
    );
}
