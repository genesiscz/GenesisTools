export function pageTitleFromPath(pathname: string): string {
    if (pathname.startsWith("/jobs")) {
        return "Pipeline Jobs";
    }

    if (pathname.startsWith("/settings")) {
        return "Settings";
    }

    if (pathname.startsWith("/videos/")) {
        return "Video Detail";
    }

    if (pathname.startsWith("/channels/")) {
        return "Channel Detail";
    }

    if (pathname.startsWith("/first-run")) {
        return "First Run";
    }

    return "Channels";
}
