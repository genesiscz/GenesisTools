import { ModelBrowser, type ModelBrowserNode } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";
export const meta: GalleryMeta = {
    family: "Structure",
    title: "Model browser",
    summary: "A compact package tree with model icons, change marks and collapsible branches.",
    components: ["ModelBrowser"],
};
const ROOT: ModelBrowserNode[] = [
    {
        name: "Library",
        icon: "package",
        children: [
            {
                name: "Borrowing",
                icon: "package",
                children: [
                    { name: "Requests", icon: "diagram" },
                    {
                        name: "BorrowRequest",
                        icon: "class",
                        children: [
                            { name: "itemKey", icon: "attribute", mark: "new", note: "stable string key" },
                            { name: "legacyId", icon: "attribute", mark: "err", note: "retired" },
                        ],
                    },
                    { name: "LoanPeriod", icon: "enumeration", mark: "warn", note: "review values" },
                    {
                        name: "BorrowingService",
                        icon: "interface",
                        children: [
                            {
                                name: "borrow",
                                icon: "method",
                                children: [
                                    { name: "Request", icon: "request" },
                                    { name: "Response", icon: "response" },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                name: "Shared types",
                icon: "package",
                open: false,
                children: [{ name: "ItemKey", icon: "primitiveType", mark: "ok" }],
            },
        ],
    },
];
export default function ModelBrowserPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab to a branch, then Enter or Space to expand it. Each chevron also has a named collapse or expand button."
        >
            <Demo title="Packages, diagrams, classes and marked attributes">
                <ModelBrowser root={ROOT} />
            </Demo>
            <Demo title="Edge case: an empty model">
                <ModelBrowser root={[]} tabs={[]} title="Empty model" />
            </Demo>
        </GalleryPage>
    );
}
