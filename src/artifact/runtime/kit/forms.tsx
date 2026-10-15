import {
    type ButtonHTMLAttributes,
    type ChangeEvent,
    cloneElement,
    type DragEvent,
    type ReactElement,
    type ReactNode,
    useId,
    useRef,
    useState,
} from "react";
import { MdInline } from "./md";
import type { BodyContent } from "./primitives";

/** A hint or note at the size of its container: markdown strings render inline, nodes pass through. */
function inlineBody(body: BodyContent): ReactNode {
    return typeof body === "string" ? <MdInline>{body}</MdInline> : body;
}

/**
 * Form controls for artifacts: buttons, a labelled Field and the inputs that
 * go in it. Every control is controlled (value plus onChange), dates are
 * "YYYY-MM-DD" strings so a time zone never shifts a day, and keyboard focus
 * always draws a 2 px ring.
 */

/** The visible keyboard focus ring every control shares. */
export const FOCUS_RING =
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-info";

const CONTROL =
    "h-9 w-full rounded-[8px] border bg-panel px-[10px] text-sm text-ink placeholder:text-dim hover:border-dim disabled:opacity-50";

/** Wiring a Field hands to its one control. Every control below accepts it. */
export interface FieldControlProps {
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
    "aria-required"?: boolean;
}

function controlClass(invalid: boolean | undefined, extra = ""): string {
    return `${CONTROL} ${invalid ? "border-err" : "border-line"} ${FOCUS_RING} ${extra}`;
}

// ─── Button ───

/** Handlers a wrapper such as Tooltip may attach; Button passes them to its element. */
export type ButtonPassThrough = Pick<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onPointerMove" | "onPointerLeave" | "onPointerDown" | "onFocus" | "onBlur" | "onKeyDown" | "aria-describedby"
>;

export interface ButtonProps extends ButtonPassThrough {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    /** Disables the button and sets aria-busy. */
    busy?: boolean;
    disabled?: boolean;
    type?: "button" | "submit";
    onClick?: () => void;
    /** Accessible name when the children are an icon. */
    ariaLabel?: string;
    children: ReactNode;
}

const BUTTON_VARIANT: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary: "border-transparent bg-accent text-canvas hover:brightness-110",
    secondary: "border-line bg-panel text-ink hover:border-dim",
    ghost: "border-transparent bg-transparent text-ink hover:bg-panel",
    danger: "border-transparent bg-err text-canvas hover:brightness-110",
};

/** Action button. Primary is a solid accent fill; `busy` shows a spinner and blocks clicks. */
export function Button({
    variant = "secondary",
    size = "md",
    busy = false,
    disabled = false,
    type = "button",
    onClick,
    ariaLabel,
    children,
    ...passThrough
}: ButtonProps) {
    const height = size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-[13px]";

    return (
        <button
            type={type}
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            {...passThrough}
            aria-label={ariaLabel}
            onClick={onClick}
            className={`inline-flex items-center justify-center gap-2 rounded-[8px] border font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${height} ${BUTTON_VARIANT[variant]} ${FOCUS_RING}`}
        >
            {busy ? (
                <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin"
                />
            ) : null}
            {children}
        </button>
    );
}

// ─── Field ───

export interface FieldProps {
    label: string;
    hint?: BodyContent;
    error?: string;
    required?: boolean;
    /** One control. It receives id, aria-describedby and aria-invalid. */
    children: ReactElement<FieldControlProps>;
}

/** Label above one control, with an optional hint and an error line the control is described by. */
export function Field({ label, hint, error, required = false, children }: FieldProps) {
    const id = useId();
    const controlId = children.props.id ?? `${id}-control`;
    const hintId = hint ? `${id}-hint` : undefined;
    const errorId = error ? `${id}-error` : undefined;
    const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={controlId} className="text-xs font-semibold text-ink">
                {label}
                {required ? (
                    <span aria-hidden="true" className="ml-0.5 text-err">
                        *
                    </span>
                ) : null}
            </label>
            {cloneElement(children, {
                id: controlId,
                "aria-describedby": describedBy,
                "aria-invalid": error ? true : children.props["aria-invalid"],
                "aria-required": required || undefined,
            })}
            {hint ? (
                <div id={hintId} className="text-xs text-dim">
                    {inlineBody(hint)}
                </div>
            ) : null}
            {error ? (
                <div id={errorId} role="alert" className="text-xs text-err">
                    {error}
                </div>
            ) : null}
        </div>
    );
}

// ─── Inputs ───

export interface TextInputProps extends FieldControlProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    mono?: boolean;
    invalid?: boolean;
    disabled?: boolean;
}

/** Single-line text input. */
export function TextInput({ value, onChange, placeholder, mono, invalid, disabled, ...wiring }: TextInputProps) {
    const bad = invalid || wiring["aria-invalid"];

    return (
        <input
            {...wiring}
            type="text"
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            aria-invalid={bad || undefined}
            onChange={(e) => onChange(e.target.value)}
            className={controlClass(bad, mono ? "font-mono" : "")}
        />
    );
}

export interface NumberInputProps extends FieldControlProps {
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    invalid?: boolean;
    disabled?: boolean;
}

/**
 * Parse what a person typed into a number. Empty is null, a comma counts as a
 * decimal point, and anything unparseable is `undefined` so the caller keeps
 * the old value instead of committing NaN.
 */
export function parseNumberDraft(draft: string): number | null | undefined {
    const text = draft.trim().replace(",", ".");

    if (text === "") {
        return null;
    }

    const value = Number(text);

    return Number.isFinite(value) ? value : undefined;
}

/**
 * Number input that keeps what the user types ("1.", "-") as a draft until
 * blur or Enter, then commits a number or null. It never commits NaN.
 */
export function NumberInput({ value, onChange, min, max, step, unit, invalid, disabled, ...wiring }: NumberInputProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const bad = invalid || wiring["aria-invalid"];
    const commit = (): void => {
        if (draft === null) {
            return;
        }

        const parsed = parseNumberDraft(draft);
        setDraft(null);

        if (parsed !== undefined && parsed !== value) {
            onChange(parsed);
        }
    };

    return (
        <div className="relative">
            <input
                {...wiring}
                type="text"
                inputMode="decimal"
                value={draft ?? (value === null ? "" : String(value))}
                disabled={disabled}
                aria-invalid={bad || undefined}
                aria-valuemin={min}
                aria-valuemax={max}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commit();
                    }

                    if (e.key === "Escape") {
                        setDraft(null);
                    }

                    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        const base = parseNumberDraft(draft ?? "") ?? value ?? 0;
                        const next = base + (e.key === "ArrowUp" ? 1 : -1) * (step ?? 1);
                        setDraft(null);
                        onChange(
                            Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, next))
                        );
                    }
                }}
                className={controlClass(bad, `text-right font-mono tabular-nums ${unit ? "pr-8" : ""}`)}
            />
            {unit ? (
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-dim">
                    {unit}
                </span>
            ) : null}
        </div>
    );
}

export interface DateInputProps extends FieldControlProps {
    /** "YYYY-MM-DD" or "". */
    value: string;
    onChange: (value: string) => void;
    min?: string;
    max?: string;
    invalid?: boolean;
    disabled?: boolean;
}

/** Native date picker over a "YYYY-MM-DD" string. */
export function DateInput({ value, onChange, min, max, invalid, disabled, ...wiring }: DateInputProps) {
    const bad = invalid || wiring["aria-invalid"];

    return (
        <input
            {...wiring}
            type="date"
            value={value}
            min={min}
            max={max}
            disabled={disabled}
            aria-invalid={bad || undefined}
            onChange={(e) => onChange(e.target.value)}
            className={controlClass(bad, "font-mono tabular-nums")}
        />
    );
}

export interface SelectOption {
    value: string;
    label: string;
}

export interface SelectProps extends FieldControlProps {
    options: SelectOption[];
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    invalid?: boolean;
    disabled?: boolean;
}

/** Native select, kit-styled. A placeholder shows as a disabled first option while the value is "". */
export function Select({ options, value, onChange, placeholder, invalid, disabled, ...wiring }: SelectProps) {
    const bad = invalid || wiring["aria-invalid"];

    return (
        <select
            {...wiring}
            value={value}
            disabled={disabled}
            aria-invalid={bad || undefined}
            onChange={(e) => onChange(e.target.value)}
            className={controlClass(bad, "pr-8")}
        >
            {placeholder ? (
                <option value="" disabled>
                    {placeholder}
                </option>
            ) : null}
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}

export interface TextareaProps extends FieldControlProps {
    value: string;
    onChange: (value: string) => void;
    rows?: number;
    mono?: boolean;
    invalid?: boolean;
    disabled?: boolean;
}

/** Multi-line text. */
export function Textarea({ value, onChange, rows = 4, mono, invalid, disabled, ...wiring }: TextareaProps) {
    const bad = invalid || wiring["aria-invalid"];

    return (
        <textarea
            {...wiring}
            value={value}
            rows={rows}
            disabled={disabled}
            aria-invalid={bad || undefined}
            onChange={(e) => onChange(e.target.value)}
            className={`${controlClass(bad, mono ? "font-mono" : "")} h-auto py-2`}
        />
    );
}

// ─── FileInput ───

export interface PickedFile {
    file: File;
    text?: string;
}

export interface FileInputProps extends FieldControlProps {
    accept?: string;
    multiple?: boolean;
    /** "text" reads each file as text and passes it with the file. */
    read?: "text" | "none";
    /** Largest file in bytes. Default 5 MB. */
    maxBytes?: number;
    onFiles: (files: PickedFile[]) => void;
    label?: string;
    hint?: BodyContent;
}

/** Human size, "12.4 KB". */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Dashed drop zone over a hidden but focusable native file input. Reads files
 * in the page (FileReader through `File.text()`), so it works from a file://
 * build with no server.
 */
export function FileInput({
    accept,
    multiple = false,
    read = "none",
    maxBytes = 5 * 1024 * 1024,
    onFiles,
    label = "Choose a file or drop it here",
    hint,
    ...wiring
}: FileInputProps) {
    const fallbackId = useId();
    const inputId = wiring.id ?? fallbackId;
    const [picked, setPicked] = useState<File[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [over, setOver] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const errorId = `${inputId}-error`;

    const takeFiles = async (list: FileList | null): Promise<void> => {
        const files = list ? Array.from(list) : [];

        if (files.length === 0) {
            return;
        }

        const tooBig = files.find((f) => f.size > maxBytes);

        if (tooBig) {
            setError(`${tooBig.name} is ${formatFileSize(tooBig.size)}, over the ${formatFileSize(maxBytes)} limit.`);
            setPicked([]);

            if (inputRef.current) {
                inputRef.current.value = "";
            }

            return;
        }

        setError(null);
        setPicked(files);
        const result: PickedFile[] = [];

        for (const file of files) {
            result.push(read === "text" ? { file, text: await file.text() } : { file });
        }

        onFiles(result);
    };

    const describedBy = [wiring["aria-describedby"], error ? errorId : undefined].filter(Boolean).join(" ");

    return (
        <div className="flex flex-col gap-1">
            <label
                htmlFor={inputId}
                onDragOver={(e: DragEvent) => {
                    e.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e: DragEvent) => {
                    e.preventDefault();
                    setOver(false);
                    void takeFiles(e.dataTransfer.files);
                }}
                className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed px-4 py-5 text-center text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-solid focus-within:outline-info ${
                    error ? "border-err" : over ? "border-accent bg-accent/5" : "border-line bg-panel hover:border-dim"
                }`}
            >
                <span className="font-medium text-ink">{label}</span>
                {picked.length > 0 ? (
                    <span className="font-mono text-xs text-dim">
                        {picked.map((f) => `${f.name} (${formatFileSize(f.size)})`).join(", ")}
                    </span>
                ) : hint ? (
                    <span className="text-xs text-dim">{inlineBody(hint)}</span>
                ) : null}
                <input
                    ref={inputRef}
                    id={inputId}
                    type="file"
                    accept={accept}
                    multiple={multiple}
                    aria-describedby={describedBy || undefined}
                    aria-invalid={error ? true : wiring["aria-invalid"]}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => void takeFiles(e.target.files)}
                    className="sr-only"
                />
            </label>
            {error ? (
                <div id={errorId} role="alert" className="text-xs text-err">
                    {error}
                </div>
            ) : null}
        </div>
    );
}
