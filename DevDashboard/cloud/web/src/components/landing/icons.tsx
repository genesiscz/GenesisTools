import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function LogoMark(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
            <path d="M4 6h16M4 6l3 3-3 3M10 15h6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function ArrowRight(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} {...props}>
            <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function ShieldCheck(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} {...props}>
            <path
                d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6l7-3z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path d="M9.5 12l1.8 1.8L15 10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function Check(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
            <path d="M5 12.5l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function CheckCircle(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} {...props}>
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 12l2.3 2.3L15.5 9.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function Wifi(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path d="M5 12.5a10 10 0 0114 0M8 16a5 5 0 018 0" strokeLinecap="round" />
            <circle cx="12" cy="19" r="1" />
        </svg>
    );
}

export function Shield(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path
                d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6l7-3z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function Cloud(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path
                d="M7 17a4 4 0 010-8 5 5 0 019.6-1.3A3.5 3.5 0 0118 17H7z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function Lock(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <rect x="5" y="10" width="14" height="10" rx="2.5" />
            <path d="M8 10V7a4 4 0 018 0v3" strokeLinecap="round" />
        </svg>
    );
}

export function Terminal(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
            <path d="M7 9l3 3-3 3M13 15h4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function Pulse(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path d="M3 13h4l2-6 4 12 2-6h6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function Bell(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 21a2 2 0 004 0" strokeLinecap="round" />
        </svg>
    );
}

export function CheckSquare(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="4" y="4" width="16" height="16" rx="3" />
        </svg>
    );
}

export function Diamond(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path d="M12 3l8 5-8 13L4 8z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function Bars(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <path d="M4 18V9m5 9V5m5 13v-6m5 6V8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function DockerWhale(props: IconProps) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
            <rect x="3" y="10" width="5" height="4" />
            <rect x="9" y="10" width="5" height="4" />
            <rect x="6" y="6" width="5" height="4" />
            <path d="M3 16c2 2 6 2 9 0 4 0 6-2 6-4" strokeLinecap="round" />
        </svg>
    );
}
