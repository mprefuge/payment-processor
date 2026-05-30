import type { HttpRequest } from '@azure/functions';

import { parseBoolean } from './parsing';

export interface HttpResponse<T = unknown> {
  status: number;
  headers?: Record<string, string>;
  body?: T;
}

export const jsonResponse = <T>(
  status: number,
  body: T,
  headers: Record<string, string> = {}
): HttpResponse<T> => ({
  status,
  headers: {
    'Content-Type': 'application/json',
    ...headers,
  },
  body,
});

export const ok = <T>(body: T): HttpResponse<T> => jsonResponse(200, body);
export const noContent = (): HttpResponse => ({ status: 204 });
export const badRequest = <T>(body: T): HttpResponse<T> => jsonResponse(400, body);
export const internalError = <T>(body: T): HttpResponse<T> => jsonResponse(500, body);

export const readBooleanQuery = (
  request: HttpRequest,
  key: string,
  defaultValue: boolean
): boolean => {
  if (request.query && typeof request.query.get === 'function') {
    return parseBoolean(request.query.get(key), defaultValue);
  }

  return parseBoolean(
    (request.query as unknown as Record<string, unknown> | undefined)?.[key],
    defaultValue
  );
};
