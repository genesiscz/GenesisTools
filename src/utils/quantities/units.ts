export interface Unit {
    readonly symbol: string;
    readonly scale: number;
    readonly dimensions: ReadonlyMap<string, number>;
}

export class QuantityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QuantityError";
    }
}

export function finiteValue(value: number): number {
    if (!Number.isFinite(value)) {
        throw new QuantityError("The calculation produced a non-finite number.");
    }

    return value;
}

export function dimensionless(): Unit {
    return { symbol: "1", scale: 1, dimensions: new Map() };
}

export function baseUnit(symbol: string): Unit {
    return { symbol, scale: 1, dimensions: new Map([[symbol, 1]]) };
}

export function sameDimension(left: Unit, right: Unit): boolean {
    return (
        left.dimensions.size === right.dimensions.size &&
        [...left.dimensions].every(([key, power]) => right.dimensions.get(key) === power)
    );
}

export function requireSameDimension(left: Unit, right: Unit): void {
    if (!sameDimension(left, right)) {
        throw new QuantityError(`Incompatible units: ${left.symbol} and ${right.symbol}.`);
    }
}

export function multiplyUnits(left: Unit, right: Unit): Unit {
    const dimensions = new Map(left.dimensions);
    for (const [key, power] of right.dimensions) {
        const sum = (dimensions.get(key) ?? 0) + power;

        if (sum === 0) {
            dimensions.delete(key);
        } else {
            dimensions.set(key, sum);
        }
    }

    return { symbol: `(${left.symbol} * ${right.symbol})`, scale: finiteValue(left.scale * right.scale), dimensions };
}

export function powerUnit(unit: Unit, exponent: number): Unit {
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 16) {
        throw new QuantityError("Unit exponents must be integers between -16 and 16.");
    }

    const scale = finiteValue(unit.scale ** exponent);

    if (scale <= 0) {
        throw new QuantityError("The unit scale is outside the supported numeric range.");
    }

    return {
        symbol: `(${unit.symbol})^${exponent}`,
        scale,
        dimensions: new Map(
            [...unit.dimensions].flatMap(([key, power]) => (exponent ? [[key, power * exponent]] : []))
        ),
    };
}

export function divideUnits(left: Unit, right: Unit): Unit {
    return multiplyUnits(left, powerUnit(right, -1));
}

export function defaultUnits(): ReadonlyMap<string, Unit> {
    const units = new Map<string, Unit>();
    for (const symbol of ["s", "m", "kg", "person", "ticket", "seat", "class", "item", "USD", "EUR", "byte"]) {
        units.set(symbol, baseUnit(symbol));
    }

    for (const [symbol, base, scale] of [
        ["second", "s", 1],
        ["minute", "s", 60],
        ["hour", "s", 3600],
        ["day", "s", 86400],
        ["week", "s", 604800],
        ["km", "m", 1000],
        ["cm", "m", 0.01],
        ["g", "kg", 0.001],
        ["people", "person", 1],
        ["tickets", "ticket", 1],
        ["seats", "seat", 1],
        ["classes", "class", 1],
        ["items", "item", 1],
    ] as const) {
        const original = units.get(base);

        if (original) {
            units.set(symbol, { ...original, symbol, scale });
        }
    }

    units.set("1", dimensionless());
    units.set("percent", { ...dimensionless(), symbol: "percent", scale: 0.01 });
    return units;
}

export function parseUnit({
    source,
    registry = defaultUnits(),
}: {
    source: string;
    registry?: ReadonlyMap<string, Unit>;
}): Unit {
    if (source.length > 256) {
        throw new QuantityError("A unit expression cannot exceed 256 characters.");
    }

    const normalized = source.trim() || "1";
    const tokens = normalized.match(/[A-Za-z_][A-Za-z_0-9]*|[*/^+-]|\d+|\S/g) ?? [];
    let index = 0;
    let result = dimensionless();
    let divide = false;
    while (index < tokens.length) {
        const name = tokens[index++];
        const unit = registry.get(name);

        if (!unit) {
            throw new QuantityError(`Unknown unit “${name}”. Define it before using it.`);
        }

        let exponent = 1;

        if (tokens[index] === "^") {
            index++;
            let sign = 1;

            if (tokens[index] === "-" || tokens[index] === "+") {
                sign = tokens[index++] === "-" ? -1 : 1;
            }

            const token = tokens[index++];

            if (!token || !/^\d+$/.test(token)) {
                throw new QuantityError("Expected an integer after the unit exponent marker.");
            }

            exponent = Number(token) * sign;
        }

        result = multiplyUnits(result, powerUnit(unit, divide ? -exponent : exponent));

        if (index < tokens.length) {
            const separator = tokens[index++];

            if ((separator !== "*" && separator !== "/") || index === tokens.length) {
                throw new QuantityError("Separate unit names with * or /, for example tickets/person/day.");
            }

            divide = separator === "/";
        }
    }

    if (result.scale <= 0) {
        throw new QuantityError("The unit scale is outside the supported numeric range.");
    }

    return { ...result, symbol: normalized };
}

export function convertValue({ value, from, to }: { value: number; from: Unit; to: Unit }): number {
    requireSameDimension(from, to);
    return finiteValue((finiteValue(value) * from.scale) / to.scale);
}
