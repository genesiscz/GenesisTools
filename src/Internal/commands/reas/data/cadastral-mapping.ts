/**
 * Maps Prague district names to the municipality names used in the MF cenova mapa XLSX.
 * Prague districts span multiple cadastral areas under a single municipality entry ("Praha").
 * Non-Prague cities map directly to their municipality name.
 */
const DISTRICT_TO_MUNICIPALITIES: Record<string, string[]> = {
    "Praha 1": ["Praha"],
    "Praha 2": ["Praha"],
    "Praha 3": ["Praha"],
    "Praha 4": ["Praha"],
    "Praha 5": ["Praha"],
    "Praha 6": ["Praha"],
    "Praha 7": ["Praha"],
    "Praha 8": ["Praha"],
    "Praha 9": ["Praha"],
    "Praha 10": ["Praha"],
    "Praha 11": ["Praha"],
    "Praha 12": ["Praha"],
    "Praha 13": ["Praha"],
    Brno: ["Brno"],
    Ostrava: ["Ostrava"],
    Plzeň: ["Plzeň"],
    Liberec: ["Liberec"],
    Olomouc: ["Olomouc"],
    "České Budějovice": ["České Budějovice"],
    "Hradec Králové": ["Hradec Králové"],
    Pardubice: ["Pardubice"],
    "Ústí nad Labem": ["Ústí nad Labem"],
    Zlín: ["Zlín"],
    "Karlovy Vary": ["Karlovy Vary"],
};

export function getCadastralMunicipalities(districtName: string): string[] {
    return DISTRICT_TO_MUNICIPALITIES[districtName] ?? [districtName];
}
