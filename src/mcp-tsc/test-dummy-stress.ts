// Dummy test file for stress testing MCP TSC diagnostics
export function dummyFunction(): string {
    const x: number = "not a number"; // Intentional type error
    const y: boolean = 123; // Another intentional type error
    return x;
}

export interface DummyInterface {
    prop: string;
    optional?: number;
    broken: string = 42; // Type error - can't assign number to string
}

export class DummyClass {
    private value: string;
    private count: number = "invalid"; // Type error
    
    constructor(value: string) {
        this.value = value;
    }
    
    getValue(): string {
        return this.value;
    }
    
    badMethod(): void {
        const z: number = true; // Type error
    }
}









