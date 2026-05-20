export type SelectValue = string | number | boolean;

export interface SelectOption {
    value: SelectValue;
    label: string;
    hint?: string;
}

export interface ConfirmOpts {
    message: string;
    initialValue?: boolean;
    danger?: boolean;
}

export interface TextOpts {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
}

export interface SelectOpts {
    message: string;
    options: SelectOption[];
    initialValue?: SelectValue;
}

export interface MultiSelectOpts {
    message: string;
    options: SelectOption[];
    required?: boolean;
    initialValues?: SelectValue[];
}

export interface TypedConfirmOpts {
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

export interface PasswordOpts {
    message: string;
    validate?: (value: string) => string | undefined; // matches TextOpts.validate convention
}

export interface SearchOpts<T = unknown> {
    message: string;
    options: (input: string) => Promise<{ value: T; label: string; hint?: string }[]>;
    /** Optional page size for backends that paginate (e.g. inquirer's search). */
    pageSize?: number;
}

export interface EditorOpts {
    message: string;
    initialValue?: string;
    postfix?: string; // file extension hint (e.g. ".md")
}

export interface NumberOpts {
    message: string;
    initialValue?: number;
    min?: number;
    max?: number;
    validate?: (n: number) => string | undefined;
}
