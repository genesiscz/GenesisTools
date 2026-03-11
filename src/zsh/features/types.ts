export interface ZshFeature {
    name: string;
    description: string;
    shellScript: string;
    shellOnly?: "zsh" | "bash";
}

export interface ZshConfig {
    enabled: string[];
    hookMode: "static" | "dynamic";
}
