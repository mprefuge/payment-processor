import { Buffer } from 'node:buffer';

import env from '../config/env';

const QBO_BASE_URL: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
  production: 'https://quickbooks.api.intuit.com/v3/company',
};

const DOC_NUMBER_MAX_LENGTH = 21;

type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

type Fetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

interface QuickBooksReference {
  value: string;
  name?: string;
}

type AccountRefLookupMetadata = {
  original: string;
  lookupName: string;
};

const ACCOUNT_LOOKUP_METADATA: unique symbol = Symbol('QuickBooksAccountLookup');

type AccountRefWithMetadata = QuickBooksReference & {
  [ACCOUNT_LOOKUP_METADATA]?: AccountRefLookupMetadata;
};

interface QuickBooksSalesItemLineDetail {
  ItemRef: QuickBooksReference;
  ItemAccountRef?: QuickBooksReference;
  TaxCodeRef?: QuickBooksReference;
}

interface QuickBooksSalesReceiptLine {
  Amount: number;
  DetailType: 'SalesItemLineDetail';
  Description?: string;
  SalesItemLineDetail: QuickBooksSalesItemLineDetail;
}

export interface QuickBooksSalesReceipt {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  DepositToAccountRef: QuickBooksReference;
  Line: QuickBooksSalesReceiptLine[];
}

interface QuickBooksJournalEntryLineDetail {
  PostingType: 'Debit' | 'Credit';
  AccountRef: QuickBooksReference;
}

interface QuickBooksJournalEntryLine {
  Amount: number;
  DetailType: 'JournalEntryLineDetail';
  Description?: string;
  JournalEntryLineDetail: QuickBooksJournalEntryLineDetail;
}

export interface QuickBooksJournalEntry {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  Line: QuickBooksJournalEntryLine[];
}

interface QuickBooksDepositLineDetail {
  AccountRef: QuickBooksReference;
}

interface QuickBooksDepositLine {
  Amount: number;
  DetailType: 'DepositLineDetail';
  Description?: string;
  DepositLineDetail: QuickBooksDepositLineDetail;
}

export interface QuickBooksBankDeposit {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  DepositToAccountRef: QuickBooksReference;
  Line: QuickBooksDepositLine[];
}

interface PostOptions {
  fetcher?: Fetcher;
  accessToken?: string;
}

interface PostResult {
  id: string;
  type: QuickBooksDocType;
  raw: unknown;
}

interface BuildSalesReceiptInput {
  docNumber: string;
  amountCents: number;
  memo?: string;
  date: string | Date;
  revenueAccountName?: string;
  depositAccountName?: string;
}

interface BuildFeesJournalEntryInput {
  docNumber: string;
  feeAmountCents: number;
  memo?: string;
  date: string | Date;
}

interface BuildSingleJournalEntryInput {
  docNumber: string;
  grossAmountCents: number;
  feeAmountCents: number;
  memo?: string;
  date: string | Date;
}

interface BuildBankDepositInput {
  docNumber: string;
  amountCents: number;
  memo?: string;
  date: string | Date;
  sourceAccountName?: string;
  targetAccountName?: string;
}

export interface PostChargeToQboInput {
  gross: number;
  fee: number;
  memo?: string;
  date: string | Date;
  options?: PostOptions;
}

export interface PostChargeToQboResult {
  qboId: string;
  type: Extract<QuickBooksDocType, 'sales-receipt' | 'journal-entry' | 'bank-deposit'>;
}

export interface PostRefundToQboInput {
  amount: number;
  memo?: string;
  date: string | Date;
  options?: PostOptions;
}

export interface PostDisputeToQboInput {
  lossAmount: number;
  feeAmount: number;
  memo?: string;
  date: string | Date;
  options?: PostOptions;
}

const ensurePositiveAmount = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }

  return Math.round(value);
};

const centsToDollars = (value: number): number => {
  return Math.round(value) / 100;
};

const normalizeDate = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid transaction date provided.');
  }

  return date.toISOString().slice(0, 10);
};

const parseDelimitedAccount = (
  raw: string,
  delimiter: string,
): AccountRefWithMetadata | null => {
  const index = raw.indexOf(delimiter);
  if (index === -1) {
    return null;
  }

  const left = raw.slice(0, index).trim();
  const right = raw.slice(index + delimiter.length).trim();
  if (!right) {
    throw new Error(
      'QuickBooks account reference delimiter provided without an ID value.',
    );
  }

  const reference: AccountRefWithMetadata = {
    value: right,
    name: left || undefined,
  };

  return reference;
};

const ensureAccountRefValue = (
  ref: AccountRefWithMetadata,
  original: string,
): AccountRefWithMetadata => {
  const value = ref.value.trim();
  if (!value) {
    throw new Error(
      `QuickBooks account reference configuration is missing an ID: "${original}".`,
    );
  }

  return { ...ref, value };
};

const createAccountRef = (input: string): AccountRefWithMetadata => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('QuickBooks account name must be provided.');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid QuickBooks account reference JSON.');
      }

      const value = typeof parsed.value === 'string' ? parsed.value.trim() : '';
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : undefined;

      if (!value) {
        throw new Error('QuickBooks account reference JSON must include a value.');
      }

      const reference: AccountRefWithMetadata = { value, name };
      return reference;
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Unable to parse QuickBooks account reference JSON: ${error.message}`
          : 'Unable to parse QuickBooks account reference JSON.',
      );
    }
  }

  const delimiters = ['::', '|'];
  for (const delimiter of delimiters) {
    const parsed = parseDelimitedAccount(trimmed, delimiter);
    if (parsed) {
      return ensureAccountRefValue(parsed, input);
    }
  }

  const isNumericId = /^\d+$/.test(trimmed);
  if (isNumericId) {
    return ensureAccountRefValue({ value: trimmed }, input);
  }

  const reference = ensureAccountRefValue({ value: trimmed, name: trimmed }, input);
  reference[ACCOUNT_LOOKUP_METADATA] = {
    original: input,
    lookupName: trimmed,
  };
  return reference;
};

const buildDocNumber = (prefix: string, date: string | Date, amountCents: number): string => {
  const formattedDate = normalizeDate(date).replace(/-/g, '');
  const amountPart = Math.abs(Math.round(amountCents)).toString().slice(-10);
  const suffix = `${formattedDate}-${amountPart}`;
  const maxPrefixLength = Math.max(1, DOC_NUMBER_MAX_LENGTH - suffix.length - 1);
  const safePrefix = prefix.slice(0, maxPrefixLength);
  return `${safePrefix}-${suffix}`.slice(0, DOC_NUMBER_MAX_LENGTH);
};


export const buildSalesReceipt = ({
  docNumber,
  amountCents,
  memo,
  date,
  revenueAccountName = env.quickBooks.accounts.revenue,
  depositAccountName = env.quickBooks.accounts.stripeClearing,
}: BuildSalesReceiptInput): QuickBooksSalesReceipt => {
  const amount = ensurePositiveAmount(amountCents, 'Sales receipt amount');
  if (amount === 0) {
    throw new Error('Sales receipt amount must be greater than zero.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    DepositToAccountRef: createAccountRef(depositAccountName),
    Line: [
      {
        Amount: centsToDollars(amount),
        DetailType: 'SalesItemLineDetail',
        Description: memo,
        SalesItemLineDetail: {
          ItemRef: createAccountRef(revenueAccountName),
          ItemAccountRef: createAccountRef(revenueAccountName),
        },
      },
    ],
  };
};

const createJournalEntryLine = (
  type: 'debit' | 'credit',
  accountName: string,
  amountCents: number,
  memo?: string,
): QuickBooksJournalEntryLine | null => {
  const amount = ensurePositiveAmount(amountCents, 'Journal entry amount');
  if (amount === 0) {
    return null;
  }

  return {
    Amount: centsToDollars(amount),
    DetailType: 'JournalEntryLineDetail',
    Description: memo,
    JournalEntryLineDetail: {
      PostingType: type === 'debit' ? 'Debit' : 'Credit',
      AccountRef: createAccountRef(accountName),
    },
  };
};

export const buildFeesJE = ({
  docNumber,
  feeAmountCents,
  memo,
  date,
}: BuildFeesJournalEntryInput): QuickBooksJournalEntry => {
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  const lines = [
    createJournalEntryLine('debit', env.quickBooks.accounts.fees, feeAmount, memo),
    createJournalEntryLine('credit', env.quickBooks.accounts.stripeClearing, feeAmount, memo),
  ].filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  if (lines.length === 0) {
    throw new Error('Fee journal entry must include at least one non-zero line.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    Line: lines,
  };
};

export const buildSingleJE = ({
  docNumber,
  grossAmountCents,
  feeAmountCents,
  memo,
  date,
}: BuildSingleJournalEntryInput): QuickBooksJournalEntry => {
  const grossAmount = ensurePositiveAmount(grossAmountCents, 'Gross amount');
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  if (grossAmount === 0) {
    throw new Error('Gross amount must be greater than zero.');
  }

  const lines = [
    createJournalEntryLine('debit', env.quickBooks.accounts.stripeClearing, grossAmount, memo),
    createJournalEntryLine('credit', env.quickBooks.accounts.revenue, grossAmount, memo),
  ];

  if (feeAmount > 0) {
    lines.push(
      createJournalEntryLine('debit', env.quickBooks.accounts.fees, feeAmount, memo),
      createJournalEntryLine('credit', env.quickBooks.accounts.stripeClearing, feeAmount, memo),
    );
  }

  const filteredLines = lines.filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  if (filteredLines.length === 0) {
    throw new Error('Journal entry must contain at least one non-zero line.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    Line: filteredLines,
  };
};

export const buildBankDeposit = ({
  docNumber,
  amountCents,
  memo,
  date,
  sourceAccountName = env.quickBooks.accounts.stripeClearing,
  targetAccountName = env.quickBooks.accounts.operatingBank,
}: BuildBankDepositInput): QuickBooksBankDeposit => {
  const amount = ensurePositiveAmount(amountCents, 'Deposit amount');
  if (amount === 0) {
    throw new Error('Deposit amount must be greater than zero.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    DepositToAccountRef: createAccountRef(targetAccountName),
    Line: [
      {
        Amount: centsToDollars(amount),
        DetailType: 'DepositLineDetail',
        Description: memo,
        DepositLineDetail: {
          AccountRef: createAccountRef(sourceAccountName),
        },
      },
    ],
  };
};

const getFetcher = (options?: PostOptions): Fetcher => {
  if (options?.fetcher) {
    return options.fetcher;
  }
  if (typeof fetch !== 'undefined') {
    return fetch;
  }
  throw new Error('Fetch API is not available in the current environment.');
};

const getAccessToken = (options?: PostOptions): string => {
  const token = options?.accessToken ?? process.env.QBO_ACCESS_TOKEN;
  if (!token) {
    throw new Error('QuickBooks access token is not configured.');
  }
  return token;
};

const getRealmId = (): string => {
  const realmId = env.quickBooks.realmId;
  if (!realmId) {
    throw new Error('QuickBooks realm ID is not configured.');
  }
  return realmId;
};

const buildQboUrl = (entity: string): string => {
  const base = QBO_BASE_URL[env.quickBooks.environment];
  const realmId = getRealmId();
  return `${base}/${encodeURIComponent(realmId)}/${entity}`;
};

const accountLookupCache = new Map<string, string>();

const QUICKBOOKS_TOKEN_URL =
  'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
}

interface QuickBooksRequestContext {
  request: (url: string, init?: RequestInit) => Promise<Response>;
}

const setAuthorizationHeader = (headers: Headers, token: string) => {
  const existing = headers.get('Authorization') ?? headers.get('authorization');
  if (!existing || !existing.trim()) {
    headers.set('Authorization', `Bearer ${token}`);
  }
};

const refreshAccessToken = async (fetcher: Fetcher): Promise<RefreshTokenResult> => {
  const { clientId, clientSecret, refreshToken } = env.quickBooks;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'QuickBooks OAuth client ID, client secret, and refresh token must be configured to refresh the access token.',
    );
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetcher(QUICKBOOKS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to refresh QuickBooks access token (status ${response.status}): ${
        errorText ?? response.statusText
      }`,
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const accessToken =
    data && typeof data === 'object' && typeof (data as Record<string, unknown>).access_token === 'string'
      ? ((data as Record<string, unknown>).access_token as string).trim()
      : '';

  if (!accessToken) {
    throw new Error('QuickBooks access token refresh response did not include an access_token value.');
  }

  const newRefreshToken =
    data && typeof data === 'object' && typeof (data as Record<string, unknown>).refresh_token === 'string'
      ? ((data as Record<string, unknown>).refresh_token as string).trim()
      : undefined;

  process.env.QBO_ACCESS_TOKEN = accessToken;
  if (newRefreshToken) {
    process.env.QBO_REFRESH_TOKEN = newRefreshToken;
    env.quickBooks.refreshToken = newRefreshToken;
  }

  return { accessToken, refreshToken: newRefreshToken };
};

const createRequestContext = (options?: PostOptions): QuickBooksRequestContext => {
  const fetcher = getFetcher(options);
  let accessToken = getAccessToken(options);
  let refreshAttempted = false;

  const execute = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    setAuthorizationHeader(headers, accessToken);
    const requestInit: RequestInit = { ...init, headers };
    return fetcher(url, requestInit as any) as Promise<Response>;
  };

  const request: QuickBooksRequestContext['request'] = async (url, init = {}) => {
    let response = await execute(url, init);

    if (response.status === 401) {
      if (refreshAttempted) {
        return response;
      }

      refreshAttempted = true;

      try {
        const refreshed = await refreshAccessToken(fetcher);
        accessToken = refreshed.accessToken;
      } catch (error) {
        throw new Error(
          `QuickBooks access token refresh failed after unauthorized response: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      response = await execute(url, init);
    }

    return response;
  };

  return { request };
};

const escapeQueryValue = (value: string): string => {
  return value.replace(/'/g, "''");
};

const buildQboQueryUrl = (query: string): string => {
  const base = QBO_BASE_URL[env.quickBooks.environment];
  const realmId = getRealmId();
  const encodedQuery = encodeURIComponent(query);
  return `${base}/${encodeURIComponent(realmId)}/query?query=${encodedQuery}`;
};

const getLookupName = (ref: AccountRefWithMetadata): string | undefined => {
  const metadata = ref[ACCOUNT_LOOKUP_METADATA];
  if (metadata?.lookupName) {
    return metadata.lookupName;
  }
  if (ref.name) {
    return ref.name;
  }
  const value = ref.value.trim();
  if (value.length > 0) {
    return value;
  }
  return undefined;
};

const isLookupRequired = (ref: AccountRefWithMetadata): boolean => {
  return Boolean(ref[ACCOUNT_LOOKUP_METADATA]);
};

const resolveAccountId = async (
  name: string,
  context: QuickBooksRequestContext,
): Promise<string> => {
  const cacheKey = `${env.quickBooks.environment}:${env.quickBooks.realmId ?? ''}:${name.toLowerCase()}`;
  const cached = accountLookupCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const query = `select Id, Name from Account where Name = '${escapeQueryValue(name)}'`;
  const url = buildQboQueryUrl(query);
  const response = await context.request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to resolve QuickBooks account "${name}" (status ${response.status}): ${
        errorText ?? response.statusText
      }`,
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const queryResponse = (data as Record<string, unknown>).QueryResponse;
  const accounts =
    queryResponse && typeof queryResponse === 'object'
      ? (queryResponse as Record<string, unknown>).Account
      : undefined;
  const accountList = Array.isArray(accounts)
    ? accounts
    : accounts
    ? [accounts]
    : [];

  const match = accountList.find((account) => {
    if (!account || typeof account !== 'object') {
      return false;
    }
    const accountName = (account as Record<string, unknown>).Name;
    if (typeof accountName !== 'string') {
      return false;
    }
    return accountName.trim().toLowerCase() === name.trim().toLowerCase();
  }) ?? accountList[0];

  if (!match || typeof match !== 'object') {
    throw new Error(
      `QuickBooks account "${name}" could not be found. ` +
        'Provide the account ID in configuration or ensure the account exists in QuickBooks.',
    );
  }

  const idValue = (match as Record<string, unknown>).Id;
  if (typeof idValue !== 'string' && typeof idValue !== 'number') {
    throw new Error(
      `QuickBooks account "${name}" does not provide a usable ID. ` +
        'Update the configuration to include the account ID.',
    );
  }

  const id = typeof idValue === 'number' ? idValue.toString() : idValue.trim();
  if (!id) {
    throw new Error(
      `QuickBooks account "${name}" returned an empty ID. Update the configuration to include the account ID.`,
    );
  }

  accountLookupCache.set(cacheKey, id);
  return id;
};

const collectAccountReferences = (
  entity: QuickBooksDocType,
  payload: QuickBooksSalesReceipt | QuickBooksJournalEntry | QuickBooksBankDeposit,
): AccountRefWithMetadata[] => {
  const references: AccountRefWithMetadata[] = [];

  const addRef = (ref: QuickBooksReference | undefined) => {
    if (ref) {
      references.push(ref as AccountRefWithMetadata);
    }
  };

  if (entity === 'sales-receipt') {
    const receipt = payload as QuickBooksSalesReceipt;
    addRef(receipt.DepositToAccountRef);
    for (const line of receipt.Line) {
      if (line.DetailType === 'SalesItemLineDetail') {
        addRef(line.SalesItemLineDetail.ItemRef);
        addRef(line.SalesItemLineDetail.ItemAccountRef);
        addRef(line.SalesItemLineDetail.TaxCodeRef);
      }
    }
  } else if (entity === 'journal-entry') {
    const journal = payload as QuickBooksJournalEntry;
    for (const line of journal.Line) {
      if (line.DetailType === 'JournalEntryLineDetail') {
        addRef(line.JournalEntryLineDetail.AccountRef);
      }
    }
  } else {
    const deposit = payload as QuickBooksBankDeposit;
    addRef(deposit.DepositToAccountRef);
    for (const line of deposit.Line) {
      if (line.DetailType === 'DepositLineDetail') {
        addRef(line.DepositLineDetail.AccountRef);
      }
    }
  }

  return references;
};

const resolveAccountReferences = async (
  entity: QuickBooksDocType,
  payload: QuickBooksSalesReceipt | QuickBooksJournalEntry | QuickBooksBankDeposit,
  context: QuickBooksRequestContext,
): Promise<void> => {
  const references = collectAccountReferences(entity, payload);
  const lookups = new Map<string, AccountRefWithMetadata[]>();

  for (const ref of references) {
    if (!isLookupRequired(ref)) {
      continue;
    }

    const lookupName = getLookupName(ref);
    if (!lookupName) {
      throw new Error(
        'QuickBooks account configuration must include an ID. ' +
          'Provide an "Account Name|Account ID" pair or a JSON string with a "value" field.',
      );
    }

    const normalizedName = lookupName.trim();
    if (!lookups.has(normalizedName)) {
      lookups.set(normalizedName, []);
    }
    lookups.get(normalizedName)?.push(ref);
  }

  for (const [name, refs] of lookups.entries()) {
    const id = await resolveAccountId(name, context);
    for (const ref of refs) {
      ref.value = id;
      if (!ref.name) {
        ref.name = name;
      }
      delete ref[ACCOUNT_LOOKUP_METADATA];
    }
  }
};

const postToQbo = async <T extends QuickBooksDocType>(
  entity: T,
  payload: T extends 'sales-receipt'
    ? QuickBooksSalesReceipt
    : T extends 'journal-entry'
    ? QuickBooksJournalEntry
    : QuickBooksBankDeposit,
  options?: PostOptions,
): Promise<PostResult> => {
  const url = buildQboUrl(
    entity === 'sales-receipt'
      ? 'salesreceipt'
      : entity === 'journal-entry'
      ? 'journalentry'
      : 'deposit',
  );
  const context = createRequestContext(options);

  await resolveAccountReferences(entity, payload, context);

  const response = await context.request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to post ${entity} to QuickBooks (status ${response.status}): ${
        errorText ?? response.statusText
      }`,
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const id = extractIdFromResponse(data, entity);

  return { id, type: entity, raw: data };
};

const extractIdFromResponse = (response: unknown, entity: QuickBooksDocType): string => {
  if (response && typeof response === 'object') {
    const key =
      entity === 'sales-receipt'
        ? 'SalesReceipt'
        : entity === 'journal-entry'
        ? 'JournalEntry'
        : 'Deposit';

    const container = (response as Record<string, unknown>)[key];
    if (container && typeof container === 'object') {
      const idValue = (container as Record<string, unknown>).Id;
      if (typeof idValue === 'string' && idValue.trim().length > 0) {
        return idValue;
      }
      if (typeof idValue === 'number' && Number.isFinite(idValue)) {
        return idValue.toString();
      }
    }

    const directId = (response as Record<string, unknown>).Id;
    if (typeof directId === 'string' && directId.trim().length > 0) {
      return directId;
    }
    if (typeof directId === 'number' && Number.isFinite(directId)) {
      return directId.toString();
    }
  }

  throw new Error('QuickBooks response did not include an identifier.');
};

export const postSalesReceipt = (
  salesReceipt: QuickBooksSalesReceipt,
  options?: PostOptions,
): Promise<PostResult> => postToQbo('sales-receipt', salesReceipt, options);

export const postJournalEntry = (
  journalEntry: QuickBooksJournalEntry,
  options?: PostOptions,
): Promise<PostResult> => postToQbo('journal-entry', journalEntry, options);

export const postBankDeposit = (
  bankDeposit: QuickBooksBankDeposit,
  options?: PostOptions,
): Promise<PostResult> => postToQbo('bank-deposit', bankDeposit, options);

export const postChargeToQbo = async ({
  gross,
  fee,
  memo,
  date,
  options,
}: PostChargeToQboInput): Promise<PostChargeToQboResult> => {
  const grossAmount = ensurePositiveAmount(gross, 'Gross amount');
  const feeAmount = ensurePositiveAmount(fee, 'Fee amount');
  const normalizedMemo = memo?.trim() || undefined;

  const strategy = env.accounting.postingStrategy;

  if (strategy === 'sales-receipt') {
    const salesReceiptDocNumber = buildDocNumber('CHG', date, grossAmount);
    const salesReceipt = buildSalesReceipt({
      docNumber: salesReceiptDocNumber,
      amountCents: grossAmount,
      memo: normalizedMemo,
      date,
    });

    const salesReceiptResult = await postSalesReceipt(salesReceipt, options);

    if (feeAmount > 0) {
      const feeDocNumber = buildDocNumber('FEE', date, feeAmount);
      const feeJournalEntry = buildFeesJE({
        docNumber: feeDocNumber,
        feeAmountCents: feeAmount,
        memo: normalizedMemo,
        date,
      });

      await postJournalEntry(feeJournalEntry, options);
    }

    return { qboId: salesReceiptResult.id, type: 'sales-receipt' };
  }

  const journalDocNumber = buildDocNumber('CHGJE', date, grossAmount + feeAmount);
  const journalEntry = buildSingleJE({
    docNumber: journalDocNumber,
    grossAmountCents: grossAmount,
    feeAmountCents: feeAmount,
    memo: normalizedMemo,
    date,
  });

  const journalResult = await postJournalEntry(journalEntry, options);
  return { qboId: journalResult.id, type: 'journal-entry' };
};

export const postRefundToQbo = async ({
  amount,
  memo,
  date,
  options,
}: PostRefundToQboInput): Promise<PostChargeToQboResult> => {
  const refundAmount = ensurePositiveAmount(amount, 'Refund amount');

  if (refundAmount === 0) {
    throw new Error('Refund amount must be greater than zero.');
  }

  const docNumber = buildDocNumber('REF', date, refundAmount);
  const lines = [
    createJournalEntryLine('debit', env.quickBooks.accounts.refunds, refundAmount, memo),
    createJournalEntryLine('credit', env.quickBooks.accounts.stripeClearing, refundAmount, memo),
  ].filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  const journalEntry: QuickBooksJournalEntry = {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo?.trim() || undefined,
    Line: lines,
  };

  const result = await postJournalEntry(journalEntry, options);
  return { qboId: result.id, type: 'journal-entry' };
};

interface PostPayoutToQboInput {
  amount: number;
  memo?: string;
  date: Date;
  options?: PostOptions;
}

export const postPayoutToQbo = async ({
  amount,
  memo,
  date,
  options,
}: PostPayoutToQboInput): Promise<PostChargeToQboResult> => {
  const payoutAmount = ensurePositiveAmount(amount, 'Payout amount');

  if (payoutAmount === 0) {
    throw new Error('Payout amount must be greater than zero.');
  }

  const docNumber = buildDocNumber('PO', date, payoutAmount);
  const deposit = buildBankDeposit({
    docNumber,
    amountCents: payoutAmount,
    memo: memo?.trim() || undefined,
    date,
  });

  const result = await postBankDeposit(deposit, options);
  return { qboId: result.id, type: 'bank-deposit' };
};

export const postDisputeToQbo = async ({
  lossAmount,
  feeAmount,
  memo,
  date,
  options,
}: PostDisputeToQboInput): Promise<PostChargeToQboResult> => {
  const normalizedLoss = ensurePositiveAmount(lossAmount, 'Dispute loss amount');
  const normalizedFee = ensurePositiveAmount(feeAmount, 'Dispute fee amount');
  const total = normalizedLoss + normalizedFee;

  if (total === 0) {
    throw new Error('Dispute posting requires a non-zero amount.');
  }

  const docNumber = buildDocNumber('DSP', date, total);
  const privateNote = memo?.trim() || undefined;
  const lines: QuickBooksJournalEntryLine[] = [];

  if (normalizedLoss > 0) {
    const lossLine = createJournalEntryLine(
      'debit',
      env.quickBooks.accounts.disputeLosses,
      normalizedLoss,
      memo,
    );
    if (lossLine) {
      lines.push(lossLine);
    }
  }

  if (normalizedFee > 0) {
    const feeLine = createJournalEntryLine(
      'debit',
      env.quickBooks.accounts.fees,
      normalizedFee,
      memo,
    );
    if (feeLine) {
      lines.push(feeLine);
    }
  }

  const clearingLine = createJournalEntryLine(
    'credit',
    env.quickBooks.accounts.stripeClearing,
    total,
    memo,
  );
  if (clearingLine) {
    lines.push(clearingLine);
  }

  const filteredLines = lines.filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  const journalEntry: QuickBooksJournalEntry = {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: privateNote,
    Line: filteredLines,
  };

  const result = await postJournalEntry(journalEntry, options);
  return { qboId: result.id, type: 'journal-entry' };
};

export const query = async <T = unknown>(query: string, options?: PostOptions): Promise<T> => {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) {
    throw new Error('QuickBooks query must be a non-empty string.');
  }

  const url = buildQboQueryUrl(trimmedQuery);
  const context = createRequestContext(options);
  const response = await context.request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `QuickBooks query failed (status ${response.status}): ${errorText ?? response.statusText}`,
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  return data as T;
};

export default {
  buildSalesReceipt,
  buildFeesJE,
  buildSingleJE,
  buildBankDeposit,
  postSalesReceipt,
  postJournalEntry,
  postBankDeposit,
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postPayoutToQbo,
  query,
};
