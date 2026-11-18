import { type Fixture, fixture, row } from "./claude-sessions";

export function logOnlyFixture(): Fixture {
    const f = fixture("30000000-1111-4111-8111-111111111111", 3);
    for (let i = 1; i <= f.turns; i++) {
        f.rows.push(row(f, `p${i}`, `/work/acme/file-${i}`, i, `shell-${i}`));
    }
    return f;
}
