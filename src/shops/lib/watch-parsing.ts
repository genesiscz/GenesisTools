export function parsePercent(input: string): number {
    const cleaned = input.replace("%", "").trim();
    const n = Number(cleaned);
    if (Number.isNaN(n) || n < 0) {
        throw new Error(`Invalid percent: ${input}. Use "15", "15%", or "0.15".`);
    }

    return n > 1 ? n / 100 : n;
}

export function parseCooldown(input: string): number {
    const m = input
        .trim()
        .toLowerCase()
        .match(/^(\d+)\s*([hd]?)$/);
    if (!m) {
        throw new Error(`Invalid cooldown: ${input}. Use "24", "24h", or "2d".`);
    }

    const n = Number(m[1]);
    return m[2] === "d" ? n * 24 : n;
}
