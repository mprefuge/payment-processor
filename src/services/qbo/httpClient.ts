import type { Fetcher, QuickBooksDocType, PostOptions, PostResult } from './types';

export interface RequestContext {
  fetcher: Fetcher;
  baseUrl: string;
  accessToken: string;
  companyId: string;
  idempotencyKey?: string;
  requestId?: string;
}

export const createRequestContext = (options?: PostOptions): RequestContext => {
  const accessToken = process.env.QBO_ACCESS_TOKEN || '';
  const companyId = process.env.QBO_COMPANY_ID || '';
  const environment = process.env.QBO_ENVIRONMENT || 'sandbox';
  const baseUrl =
    environment === 'production'
      ? 'https://quickbooks.api.intuit.com/v3/company'
      : 'https://sandbox-quickbooks.api.intuit.com/v3/company';

  return {
    fetcher: fetch,
    baseUrl,
    accessToken,
    companyId,
    idempotencyKey: options?.idempotencyKey,
    requestId: options?.requestId,
  };
};

export const buildQboUrl = (context: RequestContext, endpoint: string): string => {
  return `${context.baseUrl}/${context.companyId}/${endpoint}`;
};

export const executeQboRequest = async <T>(
  context: RequestContext,
  url: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<T> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${context.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (context.requestId) {
    headers['Request-Id'] = context.requestId;
  }

  const response = await context.fetcher(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`QBO API error ${response.status}: ${errorText}`);
  }

  return response.json() as T;
};
