import { HUE, MappingList } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Structure",
    title: "Mapping list",
    summary:
        "MappingList: old name to new name, one boxed row each. Arrow rows for aliases, stacked rows for a grammar that replaces several flags.",
    components: ["MappingList"],
};

export default function MappingListPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Nothing takes focus. A screen reader hears each row as the old value, then 'becomes' (arrow) or 'was' and 'now' (stacked), then the note."
        >
            <Demo title="Arrow rows with a note" note="aliases after a move">
                <MappingList
                    color={HUE.amber}
                    items={[
                        {
                            from: "tools old usage",
                            to: "tools new usage --provider work",
                            note: "Kept for good as a pinned door. `--json` keeps its exact bytes.",
                        },
                        {
                            from: "tools old spend …",
                            to: "tools new usage spend …",
                            note: "Kept for good: scripts call it.",
                        },
                        { from: "tools hub forecast", to: "tools new usage limits forecast" },
                    ]}
                />
            </Demo>
            <Demo title="Stacked rows" note="label, the old flags struck through, the new grammar">
                <MappingList
                    layout="stacked"
                    color={HUE.teal}
                    items={[
                        {
                            label: "Window",
                            from: "--range 6h|24h · --since Nd · --hours",
                            to: "--since / --until <90m | 7d | YYYY-MM-DD | today>",
                        },
                        {
                            label: "Output",
                            from: "--json · -j · --format text|json",
                            to: "--json · --md · --format text|json|md",
                        },
                    ]}
                />
            </Demo>
            <Demo title="Edge case: long values wrap inside their column">
                <MappingList
                    items={[
                        {
                            from: "tools a-command-with-a-very-long-name --and --many --flags --that --never --end",
                            to: "tools short",
                            note: "The arrow column keeps its width; below 640 px the row stacks and the arrow hides.",
                        },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
