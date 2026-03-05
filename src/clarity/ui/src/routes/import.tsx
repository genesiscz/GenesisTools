import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";

export function ImportPage() {
    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <h1 className="text-xl font-mono font-bold text-gray-200 mb-6">
                CLARITY <span className="text-amber-500">IMPORT</span>
            </h1>
            <Card className="border-amber-500/20">
                <CardHeader>
                    <CardTitle className="text-sm font-mono text-gray-400">FILL PREVIEW</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-gray-500 font-mono">Select a month to preview fill data...</p>
                </CardContent>
            </Card>
        </div>
    );
}
