interface Orb {
    color: string;
    size: string;
    top?: string;
    left?: string;
    right?: string;
    opacity?: number;
}

const defaultOrbs: Orb[] = [
    { color: "#7c3aed", size: "600px", top: "-20%", left: "10%", opacity: 0.35 },
    { color: "#8b5cf6", size: "400px", top: "10%", right: "5%", opacity: 0.35 },
    { color: "#ec4899", size: "300px", top: "40%", right: "30%", opacity: 0.2 },
];

interface GlowOrbsProps {
    orbs?: Orb[];
}

export function GlowOrbs({ orbs = defaultOrbs }: GlowOrbsProps) {
    return (
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
            {orbs.map((orb, i) => (
                <div
                    key={i}
                    className="absolute rounded-full blur-[100px]"
                    style={{
                        width: orb.size,
                        height: orb.size,
                        backgroundColor: orb.color,
                        top: orb.top,
                        left: orb.left,
                        right: orb.right,
                        opacity: orb.opacity ?? 0.35,
                    }}
                />
            ))}
        </div>
    );
}
