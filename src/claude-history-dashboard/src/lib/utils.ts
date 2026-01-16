import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combine multiple clsx-compatible class values into a single Tailwind-merged class string.
 *
 * Converts the provided class values (strings, arrays, objects, etc.) into a space-delimited
 * class list and resolves Tailwind utility conflicts so the final string contains the
 * intended, merged classes.
 *
 * @param inputs - One or more clsx-compatible class values (strings, arrays, objects, boolean conditions, etc.)
 * @returns The merged class string with Tailwind conflicts resolved
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}