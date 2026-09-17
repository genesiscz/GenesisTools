const BOOT_ID = "dd-boot";
const READY_CLASS = "dd-app-ready";
const FADE_MS = 1000;

export function revealAppAfterBoot(): void {
    const boot = document.getElementById(BOOT_ID);

    if (!boot) {
        document.documentElement.classList.add(READY_CLASS);
        return;
    }

    // A hidden tab never runs requestAnimationFrame, so a dashboard opened in the background
    // would keep the boot splash over a mounted app until it is focused. Reveal it at once
    // there, and keep the two-frame fade for a tab the user is actually looking at.
    if (document.hidden) {
        document.documentElement.classList.add(READY_CLASS);
        boot.remove();
        return;
    }

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            document.documentElement.classList.add(READY_CLASS);
            boot.setAttribute("aria-busy", "false");

            window.setTimeout(() => {
                boot.remove();
            }, FADE_MS + 80);
        });
    });
}
