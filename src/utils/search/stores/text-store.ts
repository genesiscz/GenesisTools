export interface TextSearchHit {
    docId: string;
    score: number;
}

export interface TextStore {
    insert(id: string, fields: Record<string, string>): void;
    remove(id: string): void;
    search(query: string, limit: number, boost?: Record<string, number>): TextSearchHit[];
    count(): number;
}
