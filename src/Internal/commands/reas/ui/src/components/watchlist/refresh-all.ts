export interface RefreshAllProgress {
    completed: number;
    failed: number;
    total: number;
    propertyId: number;
    error?: string;
}

export interface RefreshAllResult {
    completed: number;
    failed: number;
    total: number;
    failures: Array<{ propertyId: number; error: string }>;
}

export async function refreshPropertiesSequentially(options: {
    propertyIds: number[];
    refreshProperty: (propertyId: number) => Promise<void>;
    onProgress?: (progress: RefreshAllProgress) => void;
}): Promise<RefreshAllResult> {
    const failures: Array<{ propertyId: number; error: string }> = [];
    let completed = 0;

    for (const propertyId of options.propertyIds) {
        try {
            await options.refreshProperty(propertyId);
            completed += 1;
            options.onProgress?.({
                completed,
                failed: failures.length,
                total: options.propertyIds.length,
                propertyId,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ propertyId, error: message });
            options.onProgress?.({
                completed,
                failed: failures.length,
                total: options.propertyIds.length,
                propertyId,
                error: message,
            });
        }
    }

    return {
        completed,
        failed: failures.length,
        total: options.propertyIds.length,
        failures,
    };
}
