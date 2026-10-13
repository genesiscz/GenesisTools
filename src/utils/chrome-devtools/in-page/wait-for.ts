export interface PageCondition {
    /** The element(s) to look at. Without it, the condition looks at `document.body`. */
    selector?: string;
    /** Text that the element's textContent must contain. */
    text?: string;
    /** Minimum rendered height in px (laid out, not just mounted). */
    minHeight?: number;
    /** Exact `location.pathname` the page must be on. */
    path?: string;
}

export interface WaitForArgs {
    condition: PageCondition;
    timeoutMs: number;
}

export interface WaitForResult {
    ok: boolean;
    /** Milliseconds from the call until the condition held, or until the timeout. */
    ms: number;
}

/**
 * Resolves when the condition holds. Re-checks on every DOM mutation, plus every 250 ms for layout
 * changes that mutate nothing, and gives up at the deadline. Self-contained: only its source reaches the page.
 */
export function waitForCondition(args: WaitForArgs): Promise<WaitForResult> {
    const condition = args.condition;
    const started = performance.now();

    const holds = (): boolean => {
        if (condition.path !== undefined && location.pathname !== condition.path) {
            return false;
        }

        const elements: Element[] = condition.selector
            ? Array.from(document.querySelectorAll(condition.selector))
            : document.body
              ? [document.body]
              : [];
        if (elements.length === 0) {
            return (
                condition.selector === undefined && condition.text === undefined && condition.minHeight === undefined
            );
        }

        return elements.some((element) => {
            if (condition.text !== undefined && !(element.textContent ?? "").includes(condition.text)) {
                return false;
            }

            return condition.minHeight === undefined || element.getBoundingClientRect().height >= condition.minHeight;
        });
    };

    return new Promise((resolve) => {
        if (holds()) {
            resolve({ ok: true, ms: 0 });
            return;
        }

        let finished = false;
        const finish = (ok: boolean): void => {
            if (finished) {
                return;
            }

            finished = true;
            observer.disconnect();
            clearInterval(layoutCheck);
            clearTimeout(deadline);
            resolve({ ok, ms: Math.round(performance.now() - started) });
        };
        const observer = new MutationObserver(() => {
            if (holds()) {
                finish(true);
            }
        });
        observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
        const layoutCheck = setInterval(() => {
            if (holds()) {
                finish(true);
            }
        }, 250);
        const deadline = setTimeout(() => finish(holds()), args.timeoutMs);
    });
}
