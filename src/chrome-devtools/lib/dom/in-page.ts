/**
 * Code that runs INSIDE the browser page, in an isolated world (a separate JavaScript context that
 * shares the DOM), so page scripts can neither read nor replace it.
 *
 * Used by `DomPage` (./page.ts); jev's browser goal surface is its first caller.
 *
 * `installPageAgent` is sent as source text with `Function.prototype.toString()`, so its body must
 * not reference anything outside itself: no imports, no module constants. Bun strips the types and
 * leaves plain JavaScript. The design follows browser-use/jev-ultrafast `snapshot.js` (one atomic
 * read, page-scoped node ids, scoped guards, hit test before input) and typesafe-computer-use
 * `browser/perceive.py` (viewport test before any style work, input values never read).
 */

export type DomActionKind = "click" | "fill" | "select";

export interface DomField {
    type: string;
    name: string;
    id: string;
    ariaLabel: string;
    autocomplete: string;
    /** A password, one-time code or payment field. Its value is never read. */
    secret: boolean;
}

export interface DomAction {
    /** Stable for the life of the document: `n<node>`, `n<node>f` (fill), `n<node>o<option>` (select). */
    id: string;
    node: number;
    kind: DomActionKind;
    role: string;
    label: string;
    value?: string;
    checked?: boolean;
    expanded?: boolean;
    href?: string;
    option?: { index: number; label: string };
    field?: DomField;
    /** Hash of what makes this target this target, checked again right before input. */
    guard: string;
}

export interface DomSnapshot {
    url: string;
    title: string;
    text: string;
    actions: DomAction[];
    /** Candidates dropped by the action cap; they are not choosable, and the model is told how many. */
    omitted: number;
    /** Interactive elements below the fold, counted by geometry alone; scrolling reaches them. */
    belowFold: number;
    /**
     * Names of the first shown, enabled interactive elements below the fold, in page order. Never
     * choosable, since nothing on screen shows them: they tell the model that scrolling reaches a
     * named target.
     */
    belowFoldLabels: string[];
    /**
     * Names of every shown secret field in the document (password, one-time code, payment), below
     * the fold and past the action cap included, so a page that asks for a secret is known before
     * anything on it is pressed. Capped at 10.
     */
    secretFields: Array<{ label: string; field: DomField }>;
    canScrollDown: boolean;
    canScrollUp: boolean;
    historyLength: number;
    /** Hash of everything the model sees; equal markers mean an unchanged page. */
    marker: string;
}

export interface DomSnapshotOptions {
    maxActions: number;
    maxText: number;
    maxOptions: number;
    maxBelowFoldLabels: number;
}

export type DomPrepared =
    | { ok: true; x: number; y: number; screen: { x: number; y: number }; visible: boolean }
    | { ok: false; reason: "gone" | "changed" | "disabled" | "hidden" | "occluded"; detail?: string };

export interface DomSettled {
    reason: "quiet" | "cap";
    mutations: number;
    ms: number;
}

export function installPageAgent(): void {
    interface AgentState {
        version: number;
        ids: WeakMap<Element, number>;
        nodes: Map<number, Element>;
        next: number;
        observer: MutationObserver | undefined;
        mutations: number;
        changedAt: number;
    }

    const scope = globalThis as typeof globalThis & { __gtJevAgent?: Record<string, unknown> };
    if (scope.__gtJevAgent) {
        return;
    }

    const state: AgentState = {
        version: 1,
        ids: new WeakMap(),
        nodes: new Map(),
        next: 1,
        observer: undefined,
        mutations: 0,
        changedAt: 0,
    };

    const CANDIDATES = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "textarea",
        "select",
        "summary",
        "[contenteditable='']",
        "[contenteditable=true]",
        ...[
            "button",
            "link",
            "checkbox",
            "radio",
            "switch",
            "tab",
            "menuitem",
            "menuitemcheckbox",
            "menuitemradio",
            "option",
            "gridcell",
            "combobox",
            "textbox",
            "searchbox",
            "spinbutton",
            "slider",
            "treeitem",
        ].map((role) => `[role=${role}]`),
    ].join(",");
    const NO_TEXT = "script,style,noscript,template,textarea,input,select,[contenteditable=''],[contenteditable=true]";
    const MAX_SECRET_FIELDS = 10;
    // A mutation inside a shadow root is not reported to an observer on the document, so every open
    // root is observed on its own.
    const MUTATIONS: MutationObserverInit = { subtree: true, childList: true, attributes: true, characterData: true };
    const CONTAINERS = "form,dialog,[role=dialog],[role=alertdialog],article,li,tr,[role=row],fieldset";
    const SECRET_AUTOCOMPLETE = [
        "current-password",
        "new-password",
        "one-time-code",
        "cc-number",
        "cc-csc",
        "cc-exp",
        "cc-exp-month",
        "cc-exp-year",
    ];
    const NAME_FROM_CONTENT = new Set([
        "button",
        "link",
        "checkbox",
        "radio",
        "switch",
        "tab",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "option",
        "gridcell",
        "treeitem",
        "summary",
    ]);

    const hash = (text: string): string => {
        let value = 0x811c9dc5;
        for (let index = 0; index < text.length; index++) {
            value ^= text.charCodeAt(index);
            value = Math.imul(value, 0x01000193);
        }

        return (value >>> 0).toString(16);
    };

    const collapse = (text: string, limit: number): string => text.replace(/\s+/g, " ").trim().slice(0, limit);

    /**
     * The document and every OPEN shadow root in it, nested ones included. A web component or an
     * extension panel (the youtube extension mounts its side panel in one) keeps its controls in a
     * shadow root, where `document.querySelectorAll` and a document tree walker never look. A closed
     * shadow root stays invisible: the page itself cannot reach into it either.
     */
    const openRoots = (): Array<Document | ShadowRoot> => {
        const roots: Array<Document | ShadowRoot> = [document];
        for (let index = 0; index < roots.length; index++) {
            for (const element of Array.from(roots[index].querySelectorAll("*"))) {
                if (element.shadowRoot) {
                    roots.push(element.shadowRoot);
                }
            }
        }

        return roots;
    };

    /** Containment that crosses shadow boundaries, which `Node.contains` does not. */
    const within = (outer: Element, inner: Node): boolean => {
        for (let node: Node | null = inner; node; node = node instanceof ShadowRoot ? node.host : node.parentNode) {
            if (node === outer) {
                return true;
            }
        }

        return false;
    };

    /** The innermost element under a point: the document answers with a shadow host, so descend. */
    const elementAt = (x: number, y: number): Element | null => {
        let hit = document.elementFromPoint(x, y);
        while (hit?.shadowRoot) {
            const inner = hit.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === hit) {
                break;
            }

            hit = inner;
        }

        return hit;
    };

    const identity = (element: Element): number => {
        const known = state.ids.get(element);
        if (known !== undefined) {
            return known;
        }

        const id = state.next++;
        state.ids.set(element, id);
        state.nodes.set(id, element);
        return id;
    };

    const roleOf = (element: Element): string => {
        const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
        if (explicit) {
            return explicit;
        }

        if (element instanceof HTMLAnchorElement) {
            return "link";
        }

        if (element instanceof HTMLButtonElement || element.tagName === "SUMMARY") {
            return "button";
        }

        if (element instanceof HTMLSelectElement) {
            return element.multiple || element.size > 1 ? "listbox" : "combobox";
        }

        if (element instanceof HTMLTextAreaElement) {
            return "textbox";
        }

        if (element instanceof HTMLInputElement) {
            const type = element.type.toLowerCase();
            if (type === "checkbox" || type === "radio") {
                return type;
            }

            if (["button", "submit", "reset", "image"].includes(type)) {
                return "button";
            }

            if (type === "range") {
                return "slider";
            }

            if (type === "number") {
                return "spinbutton";
            }

            return type === "search" ? "searchbox" : "textbox";
        }

        if (element instanceof HTMLElement && element.isContentEditable) {
            return "textbox";
        }

        return element.tagName.toLowerCase();
    };

    const textOf = (element: Element): string => {
        let out = "";
        for (const child of Array.from(element.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
                out += child.textContent ?? "";
                continue;
            }

            if (!(child instanceof Element) || child.getAttribute("aria-hidden") === "true") {
                continue;
            }

            if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(child.tagName)) {
                continue;
            }

            out += child instanceof HTMLImageElement ? ` ${child.alt} ` : ` ${textOf(child)} `;
        }

        return out;
    };

    const nameOf = (element: Element, role: string): string => {
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
            // Ids are scoped to the tree they live in, so a control in a shadow root names its label there.
            const root = element.getRootNode();
            const scope = root instanceof ShadowRoot ? root : document;
            const named = labelledBy
                .split(/\s+/)
                .map((id) => scope.getElementById(id))
                .filter((node): node is HTMLElement => node !== null && node !== element)
                .map((node) => textOf(node))
                .join(" ");
            if (collapse(named, 200)) {
                return collapse(named, 200);
            }
        }

        const aria = element.getAttribute("aria-label");
        if (aria && collapse(aria, 200)) {
            return collapse(aria, 200);
        }

        if (
            (element instanceof HTMLInputElement ||
                element instanceof HTMLSelectElement ||
                element instanceof HTMLTextAreaElement ||
                element instanceof HTMLButtonElement) &&
            element.labels &&
            element.labels.length > 0
        ) {
            const labelled = Array.from(element.labels)
                .map((label) => textOf(label))
                .join(" ");
            if (collapse(labelled, 200)) {
                return collapse(labelled, 200);
            }
        }

        if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
            return collapse(element.value || element.type, 200);
        }

        if (element instanceof HTMLInputElement && element.type === "image") {
            return collapse(element.alt, 200);
        }

        if (NAME_FROM_CONTENT.has(role) || element instanceof HTMLAnchorElement) {
            const content = collapse(textOf(element), 200);
            if (content) {
                return content;
            }
        }

        const title = element.getAttribute("title");
        if (title && collapse(title, 200)) {
            return collapse(title, 200);
        }

        return collapse(element.getAttribute("placeholder") ?? "", 200);
    };

    const disabled = (element: Element): boolean =>
        element.matches(":disabled") || element.closest("[aria-disabled=true]") !== null;

    const shown = (element: Element): boolean => {
        if (element.closest("[aria-hidden=true],[inert]")) {
            return false;
        }

        const check = (element as HTMLElement).checkVisibility;
        return typeof check === "function"
            ? (element as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            : true;
    };

    const inViewport = (rect: DOMRect): boolean => {
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    };

    const fieldOf = (element: Element): DomField | undefined => {
        if (
            !(element instanceof HTMLInputElement) &&
            !(element instanceof HTMLTextAreaElement) &&
            !(element instanceof HTMLSelectElement) &&
            !(element instanceof HTMLElement && element.isContentEditable)
        ) {
            return undefined;
        }

        const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : element.tagName.toLowerCase();
        const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
        return {
            type,
            name: element.getAttribute("name") ?? "",
            id: element.id,
            ariaLabel: element.getAttribute("aria-label") ?? "",
            autocomplete,
            secret:
                type === "password" || autocomplete.split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.includes(token)),
        };
    };

    const currentValue = (element: Element, field: DomField | undefined): string | undefined => {
        if (field?.secret) {
            return undefined;
        }

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return element.type === "checkbox" || element.type === "radio" ? undefined : element.value.slice(0, 200);
        }

        if (element instanceof HTMLSelectElement) {
            return element.selectedOptions[0]?.label.slice(0, 200);
        }

        if (element instanceof HTMLElement && element.isContentEditable) {
            return collapse(element.textContent ?? "", 200);
        }

        return undefined;
    };

    const checkedOf = (element: Element): boolean | undefined => {
        if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
            return element.checked;
        }

        const aria = element.getAttribute("aria-checked") ?? element.getAttribute("aria-selected");
        return aria === null ? undefined : aria === "true";
    };

    const containerText = new Map<Element, string>();
    const guardOf = (element: Element, role: string, label: string, field: DomField | undefined): string => {
        const container = element.closest(CONTAINERS) ?? element.parentElement ?? element;
        let context = containerText.get(container);
        if (context === undefined) {
            context = collapse(container.textContent ?? "", 1000);
            containerText.set(container, context);
        }

        return hash(
            [
                identity(element),
                role,
                label,
                currentValue(element, field) ?? "",
                String(checkedOf(element) ?? ""),
                element instanceof HTMLSelectElement ? String(element.selectedIndex) : "",
                (element as HTMLInputElement).readOnly === true ? "ro" : "",
                disabled(element) ? "disabled" : "",
                element.getAttribute("aria-expanded") ?? "",
                element instanceof HTMLAnchorElement ? element.href : "",
                context,
            ].join("\u0001")
        );
    };

    const snapshot = (options: DomSnapshotOptions): DomSnapshot => {
        for (const [id, node] of state.nodes) {
            if (!node.isConnected) {
                state.nodes.delete(id);
            }
        }

        containerText.clear();
        const actions: DomAction[] = [];
        let omitted = 0;
        let belowFold = 0;
        const belowFoldLabels: string[] = [];
        const roots = openRoots();
        // Shadow roots come after the document, so their rows follow the page's own rows.
        for (const element of roots.flatMap((root) => Array.from(root.querySelectorAll(CANDIDATES)))) {
            // Geometry first: on a heavy page most candidates are off screen, and the style work
            // below is the expensive call in this loop.
            const rect = element.getBoundingClientRect();
            if (!inViewport(rect)) {
                if (rect.top >= innerHeight && rect.width > 0 && rect.height > 0) {
                    belowFold += 1;
                    // Style checks only for the few that get a name: a hidden or disabled control
                    // is not something scrolling will reach.
                    if (belowFoldLabels.length < options.maxBelowFoldLabels && shown(element) && !disabled(element)) {
                        const label = nameOf(element, roleOf(element));
                        if (label) {
                            belowFoldLabels.push(label.slice(0, 80));
                        }
                    }
                }

                continue;
            }

            if (!shown(element) || disabled(element)) {
                continue;
            }

            if (element instanceof HTMLInputElement && element.type === "file") {
                continue;
            }

            const role = roleOf(element);
            if (role === "gridcell" && element.querySelector("button,[role=button]")) {
                continue;
            }

            const node = identity(element);
            const label = nameOf(element, role);
            const field = fieldOf(element);
            const guard = guardOf(element, role, label, field);
            const base = {
                node,
                role,
                label,
                guard,
                ...(checkedOf(element) === undefined ? {} : { checked: checkedOf(element) }),
                ...(element.getAttribute("aria-expanded") === null
                    ? {}
                    : { expanded: element.getAttribute("aria-expanded") === "true" }),
            };
            const planned: DomAction[] = [];
            if (element instanceof HTMLSelectElement) {
                Array.from(element.options)
                    .filter((option) => !option.disabled)
                    .slice(0, options.maxOptions)
                    .forEach((option) => {
                        planned.push({
                            ...base,
                            id: `n${node}o${option.index}`,
                            kind: "select",
                            value: currentValue(element, field),
                            option: { index: option.index, label: collapse(option.label, 120) },
                            ...(field ? { field } : {}),
                        });
                    });
            } else if (field && role !== "checkbox" && role !== "radio" && role !== "button" && role !== "slider") {
                planned.push({
                    ...base,
                    id: `n${node}f`,
                    kind: "fill",
                    ...(currentValue(element, field) === undefined ? {} : { value: currentValue(element, field) }),
                    field,
                });
                if (role === "combobox") {
                    planned.push({ ...base, id: `n${node}`, kind: "click", label: `Open ${label}` });
                }
            } else {
                planned.push({
                    ...base,
                    id: `n${node}`,
                    kind: "click",
                    ...(element instanceof HTMLAnchorElement ? { href: element.href } : {}),
                });
            }

            for (const action of planned) {
                if (actions.length >= options.maxActions) {
                    omitted += 1;
                } else {
                    actions.push(action);
                }
            }
        }

        const pieces: string[] = [];
        let length = 0;
        const visibleParent = new Map<Element, boolean>();
        const range = document.createRange();
        const textRoots: Node[] = [document.body ?? document.documentElement, ...roots.slice(1)];
        for (const textRoot of textRoots) {
            const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
            for (let current = walker.nextNode(); current && length < options.maxText; current = walker.nextNode()) {
                const parent = current.parentElement;
                const text = collapse(current.textContent ?? "", 400);
                if (!parent || !text || parent.closest(NO_TEXT)) {
                    continue;
                }

                let visible = visibleParent.get(parent);
                if (visible === undefined) {
                    visible = shown(parent);
                    visibleParent.set(parent, visible);
                }

                if (!visible) {
                    continue;
                }

                range.selectNodeContents(current);
                if (!inViewport(range.getBoundingClientRect())) {
                    continue;
                }

                pieces.push(text);
                length += text.length + 1;
            }
        }

        const secretFields: DomSnapshot["secretFields"] = [];
        for (const root of roots) {
            for (const element of Array.from(root.querySelectorAll("input[type=password],[autocomplete]"))) {
                const field = fieldOf(element);
                if (secretFields.length < MAX_SECRET_FIELDS && field?.secret && shown(element) && !disabled(element)) {
                    secretFields.push({
                        label: nameOf(element, roleOf(element)) || field.name || "secret field",
                        field,
                    });
                }
            }
        }

        const text = pieces.join(" ").slice(0, options.maxText);
        const scrollHeight = document.documentElement.scrollHeight;
        const canScrollDown = scrollY + innerHeight < scrollHeight - 2;
        const canScrollUp = scrollY > 2;
        const marker = hash(
            [
                location.href,
                document.title,
                String(Math.round(scrollY)),
                String(innerWidth),
                String(innerHeight),
                text,
                actions
                    .map((action) =>
                        [action.id, action.label, action.value ?? "", String(action.checked ?? "")].join("|")
                    )
                    .join("\n"),
            ].join("\u0002")
        );
        return {
            url: location.href,
            title: document.title,
            text,
            actions,
            omitted,
            belowFold,
            belowFoldLabels,
            canScrollDown,
            canScrollUp,
            historyLength: history.length,
            marker,
            secretFields,
        };
    };

    /** Re-checks the target right before input: still there, still itself, still the thing under the point. */
    const prepare = (request: { node: number; guard: string }): DomPrepared => {
        const element = state.nodes.get(request.node);
        if (!element?.isConnected) {
            return { ok: false, reason: "gone" };
        }

        containerText.clear();
        const role = roleOf(element);
        const field = fieldOf(element);
        if (guardOf(element, role, nameOf(element, role), field) !== request.guard) {
            return { ok: false, reason: "changed" };
        }

        if (disabled(element)) {
            return { ok: false, reason: "disabled" };
        }

        if (!shown(element)) {
            return { ok: false, reason: "hidden" };
        }

        let rect = element.getBoundingClientRect();
        if (!inViewport(rect)) {
            element.scrollIntoView({ block: "center", inline: "center" });
            rect = element.getBoundingClientRect();
        }

        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = elementAt(x, y);
        const owns =
            hit !== null &&
            (hit === element ||
                within(element, hit) ||
                (hit instanceof HTMLLabelElement && hit.control === element) ||
                (element instanceof HTMLSelectElement && hit.closest("select") === element));
        if (!owns) {
            const by = hit
                ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""} ${collapse(hit.textContent ?? "", 60)}`
                : "nothing";
            return { ok: false, reason: "occluded", detail: by };
        }

        const chrome = Math.max(0, outerHeight - innerHeight);
        const side = Math.max(0, (outerWidth - innerWidth) / 2);
        return {
            ok: true,
            x,
            y,
            screen: { x: screenX + side + x, y: screenY + chrome + y },
            visible: document.visibilityState === "visible",
        };
    };

    /** Focus and select a field's whole content, so the next inserted text replaces it. */
    const focusField = (request: { node: number; guard: string }): DomPrepared => {
        const prepared = prepare(request);
        if (!prepared.ok) {
            return prepared;
        }

        const element = state.nodes.get(request.node) as HTMLElement;
        element.focus();
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.select();
        } else if (element.isContentEditable) {
            const selection = getSelection();
            const all = document.createRange();
            all.selectNodeContents(element);
            selection?.removeAllRanges();
            selection?.addRange(all);
        }

        return prepared;
    };

    /** Compares inside the page, so a secret value never travels back out. */
    const holds = (request: { node: number; expected: string }): boolean => {
        const element = state.nodes.get(request.node);
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return element.value === request.expected;
        }

        return (
            element instanceof HTMLElement &&
            collapse(element.textContent ?? "", 100000) === collapse(request.expected, 100000)
        );
    };

    const selectOption = (request: {
        node: number;
        guard: string;
        option: number;
        optionLabel: string;
    }): DomPrepared => {
        const element = state.nodes.get(request.node);
        if (!(element instanceof HTMLSelectElement)) {
            return { ok: false, reason: "gone" };
        }

        // The same checks as a click: still itself, enabled, shown, and not under a modal.
        const prepared = prepare(request);
        if (!prepared.ok) {
            return prepared;
        }

        // The guard covers the list's current value, not its options, so the option is checked by its
        // own label: a list rebuilt in another order must not select a different option at that index.
        const option = element.options[request.option];
        if (!option || option.disabled || collapse(option.label, 120) !== request.optionLabel) {
            return { ok: false, reason: "changed", detail: "the option moved or was disabled" };
        }

        element.selectedIndex = request.option;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return prepared;
    };

    const selected = (request: { node: number; option: number }): boolean => {
        const element = state.nodes.get(request.node);
        return element instanceof HTMLSelectElement && element.selectedIndex === request.option;
    };

    /** Starts counting DOM changes. Called right before input so the settle wait sees the first one. */
    const arm = (): void => {
        state.observer?.disconnect();
        state.mutations = 0;
        state.changedAt = 0;
        state.observer = new MutationObserver((records) => {
            state.mutations += records.length;
            state.changedAt = performance.now();
        });
        for (const root of openRoots()) {
            state.observer.observe(root, MUTATIONS);
        }
    };

    /**
     * Resolves once the page has changed and then stayed quiet, or at the cap. Event driven: the
     * mutation observer wakes it, nothing polls. The observation that ends this wait is the next
     * decision's input, so waiting costs no extra round trip.
     */
    const settle = (options: { capMs: number; quietMs: number }): Promise<DomSettled> => {
        const started = performance.now();
        return new Promise((resolve) => {
            let quiet: ReturnType<typeof setTimeout> | undefined;
            let watcher: MutationObserver | undefined;
            const finish = (reason: DomSettled["reason"]) => {
                clearTimeout(cap);
                clearTimeout(quiet);
                watcher?.disconnect();
                state.observer?.disconnect();
                state.observer = undefined;
                resolve({ reason, mutations: state.mutations, ms: Math.round(performance.now() - started) });
            };
            const cap = setTimeout(() => finish("cap"), options.capMs);
            const restart = () => {
                clearTimeout(quiet);
                quiet = setTimeout(() => finish("quiet"), options.quietMs);
            };
            if (state.mutations > 0) {
                restart();
            }

            watcher = new MutationObserver(restart);
            for (const root of openRoots()) {
                watcher.observe(root, MUTATIONS);
            }
        });
    };

    const scroll = (direction: 1 | -1): number => {
        const before = scrollY;
        scrollBy(0, direction * innerHeight * 0.8);
        return Math.round(scrollY - before);
    };

    scope.__gtJevAgent = { snapshot, prepare, focusField, holds, selectOption, selected, arm, settle, scroll };
}
