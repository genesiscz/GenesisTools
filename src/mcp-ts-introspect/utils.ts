import type { ExportInfo } from "./types";
import logger from "../logger";

export function filterExports(
    exports: ExportInfo[],
    searchTerm?: string,
    limit?: number
): ExportInfo[] {
    let filtered = exports;
    
    // Apply search filter
    if (searchTerm) {
        try {
            const regex = new RegExp(searchTerm, "i");
            filtered = exports.filter(exp => 
                regex.test(exp.name) ||
                regex.test(exp.typeSignature) ||
                (exp.description && regex.test(exp.description))
            );
            logger.info(`Filtered ${exports.length} exports to ${filtered.length} using pattern: ${searchTerm}`);
        } catch (error) {
            logger.warn(`Invalid regex pattern '${searchTerm}': ${error}`);
            // Fall back to simple string matching
            const lowerSearch = searchTerm.toLowerCase();
            filtered = exports.filter(exp => 
                exp.name.toLowerCase().includes(lowerSearch) ||
                exp.typeSignature.toLowerCase().includes(lowerSearch) ||
                (exp.description && exp.description.toLowerCase().includes(lowerSearch))
            );
        }
    }
    
    // Apply limit
    if (limit && limit > 0 && filtered.length > limit) {
        logger.info(`Limiting results from ${filtered.length} to ${limit}`);
        filtered = filtered.slice(0, limit);
    }
    
    return filtered;
}