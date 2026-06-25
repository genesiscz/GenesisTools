export function isAuthHttpStatus(status: number): boolean {
    return status === 401 || status === 403;
}
