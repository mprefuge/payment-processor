export const nowUtc = (): Date => new Date();
export const toIsoString = (date: Date): string => date.toISOString();
export const fromUnixSeconds = (timestamp: number): Date => new Date(timestamp * 1000);
