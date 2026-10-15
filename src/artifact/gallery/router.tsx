import { Button, Card, CodeBlock, Router, RouterLink, useNavigate, useParams, useRoutePath } from "@artifact/kit";
import { type ReactNode, useContext } from "react";
import { Demo, type GalleryMeta, GalleryPage, InGallery } from "./_frame";

export const meta: GalleryMeta = {
    family: "Router",
    title: "Router",
    summary: "History API routing for multi-page artifacts, with params, links and a fallback. Deep links reload fine.",
    components: ["Router", "RouterLink"],
};

const ITEMS = [
    { id: "1", name: "Coffee mug", stock: 42 },
    { id: "2", name: "Notebook", stock: 7 },
    { id: "3", name: "Desk lamp", stock: 0 },
];

const USAGE = `<Router
    routes={[
        { path: "/", element: <Home /> },
        { path: "/items/:id", element: <Item /> },
    ]}
    fallback={<NotFound />}
/>`;

function Nav() {
    const path = useRoutePath();

    return (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <RouterLink to="/" className="text-accent underline">
                Home
            </RouterLink>
            {ITEMS.map((item) => (
                <RouterLink key={item.id} to={`/items/${item.id}`} className="text-accent underline">
                    {item.name}
                </RouterLink>
            ))}
            <RouterLink to="/missing/page" className="text-accent underline">
                A missing page
            </RouterLink>
            <span className="text-dim">
                route: <code>{path}</code>
            </span>
        </div>
    );
}

function Home() {
    return <Card title="Home">Pick an item above. The address bar changes and Back works.</Card>;
}

function Item() {
    const { id } = useParams();
    const navigate = useNavigate();
    const item = ITEMS.find((i) => i.id === id);

    if (!item) {
        return <Card tone="err">No item {id}.</Card>;
    }

    return (
        <Card title={item.name} tone={item.stock === 0 ? "warn" : undefined}>
            <p>
                Item {item.id}, {item.stock} in stock.
            </p>
            <div className="mt-2">
                <Button size="sm" variant="secondary" onClick={() => navigate("/")}>
                    Back home with useNavigate
                </Button>
            </div>
        </Card>
    );
}

/** RouterLink and the route hooks need a Router ancestor, so the nav renders inside every route. */
function Screen({ children }: { children: ReactNode }) {
    return (
        <>
            <Nav />
            {children}
        </>
    );
}

function LiveRouter() {
    return (
        <Router
            routes={[
                {
                    path: "/",
                    element: (
                        <Screen>
                            <Home />
                        </Screen>
                    ),
                },
                {
                    path: "/items/:id",
                    element: (
                        <Screen>
                            <Item />
                        </Screen>
                    ),
                },
            ]}
            fallback={
                <Screen>
                    <Card tone="err">Not found: the fallback renders for any other path.</Card>
                </Screen>
            }
        />
    );
}

export default function RouterPage() {
    // Inside the gallery index the Router would rewrite the index's own URL, so the live demo runs in a frame
    // that loads this page on its own; opened directly, the page runs the Router itself.
    const embedded = useContext(InGallery);

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="RouterLink is a plain anchor: Tab reaches it, Enter follows it, and Cmd-click still opens a new tab. The browser's Back and Forward move through the routes."
        >
            <Demo
                title="Live router"
                note={embedded ? "runs in a frame, so the gallery URL stays put" : "this page's own URL"}
            >
                {embedded ? (
                    <iframe
                        title="Router demo"
                        src="router"
                        className="h-[34rem] w-full rounded-card border border-line bg-canvas"
                    />
                ) : (
                    <LiveRouter />
                )}
            </Demo>
            <Demo title="Usage">
                <CodeBlock lang="tsx">{USAGE}</CodeBlock>
            </Demo>
            <Demo title="Edge case: an unknown path" note="the fallback, or the / route when no fallback is given">
                <p className="text-dim">Follow "A missing page" in the live demo to see the fallback.</p>
            </Demo>
        </GalleryPage>
    );
}
