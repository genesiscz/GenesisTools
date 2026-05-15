interface WeatherCardProps {
    tempC: number | null;
    description: string;
    sunrise: string | null;
    sunset: string | null;
    label: string;
    error?: string;
}

function timeOnly(value: string | null): string {
    if (!value) {
        return "—";
    }

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
        return value;
    }

    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function WeatherCard({ tempC, description, sunrise, sunset, label, error }: WeatherCardProps) {
    return (
        <div className="dd-panel flex flex-col gap-2 p-4">
            <h3 className="dd-accent-text text-sm font-bold tracking-widest">WEATHER</h3>
            <span className="font-mono text-xs" style={{ color: "var(--dd-text-muted)" }}>
                {label}
            </span>
            {error ? (
                <p className="font-mono text-sm" style={{ color: "var(--dd-text-muted)" }}>
                    Unavailable
                </p>
            ) : (
                <>
                    <span className="text-3xl font-bold font-mono" style={{ color: "var(--dd-text-primary)" }}>
                        {tempC === null ? "—" : `${tempC.toFixed(1)}°C`}
                    </span>
                    <span className="font-mono text-sm" style={{ color: "var(--dd-text-secondary)" }}>
                        {description || "—"}
                    </span>
                    <div
                        className="mt-1 flex justify-between font-mono text-xs"
                        style={{ color: "var(--dd-text-muted)" }}
                    >
                        <span>↑ {timeOnly(sunrise)}</span>
                        <span>↓ {timeOnly(sunset)}</span>
                    </div>
                </>
            )}
        </div>
    );
}
