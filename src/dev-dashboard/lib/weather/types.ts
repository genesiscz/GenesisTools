export interface WeatherSnapshot {
    tempC: number | null;
    weatherCode: number | null;
    description: string;
    sunrise: string | null;
    sunset: string | null;
    label: string;
    fetchedAt: string;
    error?: string;
}
