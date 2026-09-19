import type { CircuitGraph } from "../lib/arena/circuit";
import { ARENA_HEIGHT, ARENA_WIDTH, type ArenaSnapshot } from "../lib/arena/types";

export interface ArenaPalette {
    background: string;
    foreground: string;
    primary: string;
    muted: string;
    border: string;
    danger: string;
    food: string;
}
export function arenaPalette(element: HTMLElement): ArenaPalette {
    const css = getComputedStyle(element);
    return {
        background: css.getPropertyValue("--background").trim(),
        foreground: css.getPropertyValue("--foreground").trim(),
        primary: css.getPropertyValue("--primary").trim(),
        muted: css.getPropertyValue("--muted-foreground").trim(),
        border: css.getPropertyValue("--border").trim(),
        danger: css.getPropertyValue("--destructive").trim(),
        food: css.getPropertyValue("--chart-2").trim() || css.getPropertyValue("--primary").trim(),
    };
}
export function drawArena(canvas: HTMLCanvasElement, state: ArenaSnapshot, palette: ArenaPalette): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return;
    }
    ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
    ctx.strokeStyle = palette.border;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    for (let x = 20; x < ARENA_WIDTH; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ARENA_HEIGHT);
        ctx.stroke();
    }

    for (let y = 20; y < ARENA_HEIGHT; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(ARENA_WIDTH, y);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.primary;
    ctx.strokeRect(10, 10, ARENA_WIDTH - 20, ARENA_HEIGHT - 20);
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = palette.muted;
    ctx.fillText("SUGAR FIELD / 01", 28, 34);
    ctx.textAlign = "right";
    ctx.fillText(`SEED ${state.seed}`, ARENA_WIDTH - 28, 34);
    ctx.textAlign = "left";
    for (const sugar of state.food) {
        ctx.save();
        ctx.translate(sugar.x, sugar.y);
        ctx.rotate(Math.PI / 4);
        ctx.shadowColor = palette.food;
        ctx.shadowBlur = 18;
        ctx.fillStyle = palette.food;
        ctx.fillRect(-7, -7, 14, 14);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(-11, -11, 22, 22);
        ctx.restore();
    }
    ctx.strokeStyle = palette.primary;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    state.trail.forEach((point, index) => {
        if (index === 0) {
            ctx.moveTo(point.x, point.y);
        } else {
            ctx.lineTo(point.x, point.y);
        }
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    const hazard = state.hazard;
    if (hazard.phase !== "idle") {
        ctx.save();
        ctx.translate(hazard.x, hazard.y);
        ctx.fillStyle = palette.danger;
        ctx.strokeStyle = palette.danger;
        ctx.lineWidth = 2;
        ctx.globalAlpha = hazard.phase === "strike" ? 0.35 : 0.08;
        ctx.beginPath();
        ctx.arc(0, 0, hazard.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.setLineDash(hazard.phase === "strike" ? [] : [7, 7]);
        ctx.beginPath();
        ctx.arc(0, 0, hazard.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(-hazard.radius - 9, 0);
        ctx.lineTo(hazard.radius + 9, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -hazard.radius - 9);
        ctx.lineTo(0, hazard.radius + 9);
        ctx.stroke();
        ctx.font = "bold 12px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(
            hazard.phase === "strike" ? "SWAT!" : `INCOMING ${Math.max(0, hazard.until - state.elapsed).toFixed(1)}s`,
            0,
            -hazard.radius - 15
        );
        if (hazard.phase === "strike") {
            ctx.rotate(-0.5);
            ctx.lineWidth = 7;
            ctx.beginPath();
            ctx.moveTo(0, 26);
            ctx.lineTo(0, 145);
            ctx.stroke();
            ctx.lineWidth = 3;
            ctx.strokeRect(-36, -30, 72, 58);
            ctx.globalAlpha = 0.5;
            for (let x = -24; x <= 24; x += 12) {
                ctx.beginPath();
                ctx.moveTo(x, -30);
                ctx.lineTo(x, 28);
                ctx.stroke();
            }
        }
        ctx.restore();
    }
    const fly = state.fly;
    ctx.save();
    ctx.translate(fly.x, fly.y);
    ctx.rotate(fly.angle);
    ctx.globalAlpha = fly.invulnerable > 0 ? 0.55 + Math.sin(state.elapsed * 35) * 0.3 : 1;
    ctx.fillStyle = palette.foreground;
    ctx.globalAlpha *= 0.75;
    const flap = state.status === "running" ? Math.sin(state.elapsed * 80) * 0.25 : 0;
    for (const side of [-1, 1]) {
        ctx.save();
        ctx.rotate(side * (0.4 + flap));
        ctx.beginPath();
        ctx.ellipse(-2, side * 10, 12, 5, side * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = fly.dash > 0 ? palette.food : palette.primary;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = fly.dash > 0 ? 20 : 6;
    ctx.beginPath();
    ctx.ellipse(0, 0, 11, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = palette.foreground;
    ctx.beginPath();
    ctx.arc(8, -4, 2.5, 0, Math.PI * 2);
    ctx.arc(8, 4, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (state.status !== "running") {
        ctx.fillStyle = palette.background;
        ctx.globalAlpha = 0.78;
        ctx.fillRect(220, 185, 460, 150);
        ctx.globalAlpha = 1;
        ctx.textAlign = "center";
        ctx.fillStyle = palette.foreground;
        ctx.font = "600 26px system-ui, sans-serif";
        ctx.fillText(
            state.status === "won"
                ? "Sugar secured."
                : state.status === "lost"
                  ? "Round over."
                  : state.status === "paused"
                    ? "Paused."
                    : "A fly. A swatter. Your move.",
            450,
            245
        );
        ctx.fillStyle = palette.muted;
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText(
            state.status === "ready"
                ? "Choose a controller and start a round"
                : `${state.sugar} sugar · ${state.dodges} dodges · ${state.elapsed.toFixed(1)} seconds`,
            450,
            280
        );
        ctx.textAlign = "left";
    }
}

export function drawCircuit(
    canvas: HTMLCanvasElement,
    graph: CircuitGraph | null,
    state: ArenaSnapshot,
    palette: ArenaPalette
): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return;
    }
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    if (!graph) {
        ctx.fillStyle = palette.muted;
        ctx.font = "12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Circuit loads when a MaleCNS round starts", width / 2, height / 2);
        return;
    }
    const count = Math.min(240, graph.neurons.length);
    const points = Array.from(
        { length: count },
        (_, i) => graph.neurons[Math.floor((i * graph.neurons.length) / count)]
    );
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    points.forEach((point, i) => {
        const rate = state.neural?.activity[i] ?? 0;
        ctx.fillStyle = rate > 1 ? palette.primary : palette.muted;
        ctx.globalAlpha = rate > 1 ? 0.5 + Math.min(0.5, rate / 100) : 0.2;
        ctx.beginPath();
        ctx.arc(
            20 + ((point.x - minX) / Math.max(1, maxX - minX)) * (width - 40),
            15 + ((point.y - minY) / Math.max(1, maxY - minY)) * (height - 30),
            rate > 1 ? 2.8 : 1.6,
            0,
            Math.PI * 2
        );
        ctx.fill();
    });
    ctx.globalAlpha = 1;
}
