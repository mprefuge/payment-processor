import type { HttpRequest } from '@azure/functions';

import { parseBoolean } from './parsing';

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
