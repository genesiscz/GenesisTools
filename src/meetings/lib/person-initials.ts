/** A name's words without accents, as an initial reads them. */
function nameWords(name: string): string[] {
    return name
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/** The forms an initial can take, shortest first: "A", then "AE", then "AliceExample". */
function initialForms(name: string): string[] {
    const words = nameWords(name);

    if (words.length === 0) {
        return [name];
    }

    const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);
    return [
        words[0]![0]!.toUpperCase(),
        words.map((word) => word[0]!.toUpperCase()).join(""),
        words.map(capital).join(""),
    ];
}

/**
 * The initial of each person, as a legend prints it and a decision may name them: the first letter of the first word
 * ("A" for Alice Example), the first letters of every word when another person shares that letter ("AE"), or the
 * words in full when those are shared too. Two people never get one initial: a name still shared after that gets its
 * place in `names` after it.
 */
export function personInitials(names: readonly string[]): Map<string, string> {
    const initials = new Map<string, string>();
    const taken = new Set<string>();
    let waiting = [...new Set(names)];

    for (let level = 0; level < 3 && waiting.length > 0; level++) {
        const forms = new Map(
            waiting.map((name) => {
                const all = initialForms(name);
                return [name, all[Math.min(level, all.length - 1)]!];
            })
        );
        const counts = new Map<string, number>();

        for (const form of forms.values()) {
            counts.set(form, (counts.get(form) ?? 0) + 1);
        }

        waiting = waiting.filter((name) => {
            const form = forms.get(name)!;

            if (counts.get(form) !== 1 || taken.has(form)) {
                return true;
            }

            initials.set(name, form);
            taken.add(form);
            return false;
        });
    }

    waiting.forEach((name, index) => {
        const form = `${initialForms(name).at(-1)}${index + 1}`;
        initials.set(name, form);
        taken.add(form);
    });
    return initials;
}
