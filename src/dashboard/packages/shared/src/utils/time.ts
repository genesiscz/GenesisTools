/**
 * Format milliseconds to HH:MM:SS.D format
 */
export function formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const deciseconds = Math.floor((ms % 1000) / 100);

    const pad = (n: number) => n.toString().padStart(2, "0");

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${deciseconds}`;
}

/**
 * Parse time string (MM:SS or HH:MM:SS) to milliseconds
 */
export function parseTime(timeStr: string): number {
    const parts = timeStr.split(":").map(Number);

    if (parts.length === 2) {
        // MM:SS
        const [minutes, seconds] = parts;
        return (minutes * 60 + seconds) * 1000;
    }

    if (parts.length === 3) {
        // HH:MM:SS
        const [hours, minutes, seconds] = parts;
        return (hours * 3600 + minutes * 60 + seconds) * 1000;
    }

    return 0;
}

/**
 * Generate a unique ID for timers
 */
export function generateTimerId(): string {
    return `timer_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
