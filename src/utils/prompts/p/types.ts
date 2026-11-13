export type SelectValue = string | number | boolean;

/**
 * What a prompt does when the user cancels it (Escape, Ctrl-C). "exit", the default, prints the cancel message and
 * ends the process with exit code 0. "back" returns the cancel symbol in place of an answer, so the caller's own
 * `p.isCancel(answer)` branch decides (go back to a menu, return, throw).
 */
export type CancelOutcome = "exit" | "back";

export interface CancelOpts {
    cancel?: CancelOutcome;
}

/** A choice of select and multiselect. Its value may be any value (clack and inquirer hand the same reference back). */
export interface SelectOption<V = SelectValue> {
    value: V;
    label: string;
    hint?: string;
}

export interface ConfirmOpts extends CancelOpts {
    message: string;
    initialValue?: boolean;
    danger?: boolean;
    /** The labels of the two answers (clack draws them; inquirer's yes/no prompt has none). */
    active?: string;
    inactive?: string;
}

export interface TextOpts extends CancelOpts {
    message: string;
    placeholder?: string;
    initialValue?: string;
    /** The answer when the user submits an empty line (clack's defaultValue; inquirer's default). */
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
}

export interface SelectOpts<V = SelectValue> extends CancelOpts {
    message: string;
    options: SelectOption<V>[];
    initialValue?: V;
}

export interface MultiSelectOpts<V = SelectValue> extends CancelOpts {
    message: string;
    options: SelectOption<V>[];
    required?: boolean;
    initialValues?: V[];
}

export interface TypedConfirmOpts extends CancelOpts {
    message: string;
    phrase: string;
    caseSensitive?: boolean;
}

export interface Spinner {
    start(msg?: string): void;
    stop(msg?: string): void;
    message(msg: string): void;
}

export interface Log {
    info(msg: string): void;
    success(msg: string): void;
    warn(msg: string): void;
    warning(msg: string): void; // alias for warn (existing ~5 call sites use .warning)
    error(msg: string): void;
    step(msg: string): void;
    message(msg: string | string[]): void; // clack's real log.message (~25 sites); array → joined
}

export interface PasswordOpts extends CancelOpts {
    message: string;
    validate?: (value: string) => string | undefined; // matches TextOpts.validate convention
}

export interface SearchOpts<T = unknown> extends CancelOpts {
    message: string;
    options: (input: string) => Promise<{ value: T; label: string; hint?: string }[]>;
    /** Optional page size for backends that paginate (e.g. inquirer's search). */
    pageSize?: number;
}

export interface EditorOpts extends CancelOpts {
    message: string;
    initialValue?: string;
    postfix?: string; // file extension hint (e.g. ".md")
}

export interface NumberOpts extends CancelOpts {
    message: string;
    initialValue?: number;
    min?: number;
    max?: number;
    validate?: (n: number) => string | undefined;
}
