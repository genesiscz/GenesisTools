export type ZeroFocusTimeLabel = "0m" | "--";

export function formatFocusTime(minutes: number, zeroLabel: ZeroFocusTimeLabel = "0m"): string {
    if (minutes === 0) {
        return zeroLabel;
    }

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours === 0) {
        return `${mins}m`;
    }

    if (mins === 0) {
        return `${hours}h`;
    }

    return `${hours}h ${mins}m`;
}

export function formatParkingRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) {
        return "Just now";
    }

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    if (hours < 24) {
        return `${hours}h ago`;
    }

    if (days === 1) {
        return "Yesterday";
    }

    if (days < 7) {
        return `${days} days ago`;
    }

    return new Date(date).toLocaleDateString();
}

export function formatCompactRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) {
        return "Just now";
    }

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    if (hours < 24) {
        return `${hours}h ago`;
    }

    if (days < 7) {
        return `${days}d ago`;
    }

    return new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
    });
}

/**
 * Format time elapsed since a blocker was set, in human-readable form.
 * Ranges from "Just now" to "N weeks ago".
 */
export function formatTimeBlocked(blockedSince: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(blockedSince).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days === 0) {
        if (hours === 0) {
            return "Just now";
        }

        if (hours === 1) {
            return "1 hour ago";
        }

        return `${hours} hours ago`;
    }

    if (days === 1) {
        return "1 day ago";
    }

    if (days < 7) {
        return `${days} days ago`;
    }

    if (days < 14) {
        return "1 week ago";
    }

    return `${Math.floor(days / 7)} weeks ago`;
}

/**
 * Compact relative time since a blocker was set.
 * Returns short-form labels: "now", "2h", "3d", "1w".
 */
export function formatTimeBlockedCompact(blockedSince: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(blockedSince).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days === 0) {
        if (hours === 0) {
            return "now";
        }

        return `${hours}h`;
    }

    if (days < 7) {
        return `${days}d`;
    }

    return `${Math.floor(days / 7)}w`;
}

export function formatHandoffRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
        return "Today";
    }

    if (days === 1) {
        return "Yesterday";
    }

    if (days < 7) {
        return `${days} days ago`;
    }

    if (days < 30) {
        return `${Math.floor(days / 7)} weeks ago`;
    }

    return new Date(date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}
