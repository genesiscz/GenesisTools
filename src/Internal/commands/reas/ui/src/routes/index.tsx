import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
    component: IndexPage,
});

function IndexPage() {
    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <h1 className="text-2xl font-mono font-bold text-gray-200">REAS Analyzer</h1>
            <p className="text-sm text-gray-500 font-mono mt-2">Dashboard loading...</p>
        </div>
    );
}
