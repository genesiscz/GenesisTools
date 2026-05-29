const BOOT_ID = "dd-boot";
const READY_CLASS = "dd-app-ready";
const FADE_MS = 1000;

export function revealAppAfterBoot(): void {
    const boot = document.getElementById(BOOT_ID);

    if (!boot) {
        document.documentElement.classList.add(READY_CLASS);
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
