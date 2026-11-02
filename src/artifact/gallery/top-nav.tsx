import { ThemeToggle, TopNav } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Layout",
    title: "Top bar",
    summary:
        "TopNav: a sticky blurred bar with a brand, section links and a theme button. Pass it to Page nav; its row lines up with the content.",
    components: ["TopNav", "ThemeToggle"],
};

export default function TopNavPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab walks the section links, then the theme button. Enter follows a link. Space or Enter on the button steps system, light, dark; its label says the current mode."
        >
            <Demo title="Brand, section links and the theme button" note="in a page: Page nav={<TopNav … />}">
                <TopNav
                    brand="Usage design, **centered**"
                    theme
                    links={[
                        { href: "#tree", label: "1 tree" },
                        { href: "#layers", label: "2 layers" },
                        { href: "#order", label: "3 build order" },
                    ]}
                />
            </Demo>
            <Demo title="Edge case: a long brand and no links" note="the row scrolls sideways instead of wrapping">
                <TopNav brand="A very long working title for a design document, **draft three**" />
            </Demo>
            <Demo
                title={'ThemeToggle variant="cycle"'}
                note="the button TopNav uses; the segmented control stays the default"
            >
                <ThemeToggle variant="cycle" />
            </Demo>
        </GalleryPage>
    );
}
