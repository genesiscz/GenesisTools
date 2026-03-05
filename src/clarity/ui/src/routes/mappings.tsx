import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";

export function MappingsPage() {
    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <h1 className="text-xl font-mono font-bold text-gray-200 mb-6">
                WORK ITEM <span className="text-amber-500">&harr;</span> CLARITY MAPPINGS
            </h1>
            <Card className="border-amber-500/20">
                <CardHeader>
                    <CardTitle className="text-sm font-mono text-gray-400">MAPPINGS</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-gray-500 font-mono">Loading mappings...</p>
                </CardContent>
            </Card>
        </div>
    );
}
