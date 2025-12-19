// Dummy test file for stress testing MCP TSC diagnostics
export function dummyFunction(): string {
    const x: number = "not a number"; // Intentional type error
    return x;
}

export interface DummyInterface {
    prop: string;
    optional?: number;
}

export class DummyClass {
    private value: string;

    constructor(value: string) {
        this.value = value;
    }

    getValue(): string {
        return this.value;
    }
}












