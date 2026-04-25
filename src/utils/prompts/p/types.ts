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
    error(msg: string): void;
    step(msg: string): void;
}
