import { ServiceContext } from "../shared/types";

export type QboDocType =
  | "SalesReceipt"
  | "RefundReceipt"
  | "JournalEntry"
  | "Transfer";

type FetchFn = typeof fetch;

type OAuthTokens = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
};

type RequestOptions = {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  retry?: boolean;
};

type QueryResponse<T> = {
  QueryResponse?: Record<string, T[]>;
};

type CreatedEntity<T extends QboDocType> =
  | { [K in T]: { Id: string } & Record<string, unknown> }
  | ({ Id: string } & Record<string, unknown>);

const DEFAULT_MINOR_VERSION = "65";
const DEFAULT_EXPIRATION_BUFFER = 60_000;
const DEFAULT_ACCESS_TOKEN_TTL = 60 * 60 * 1000; // 1 hour

const docTypePath: Record<QboDocType, string> = {
  SalesReceipt: "salesreceipt",
  RefundReceipt: "refundreceipt",
  JournalEntry: "journalentry",
  Transfer: "transfer",
};

const defaultBaseUrl = (env: ServiceContext["env"]): string =>
  env.QBO_ENV === "prod"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

const defaultTokenUrl = () =>
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const encodeBasicAuth = (clientId: string, clientSecret: string) =>
  Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

const parseJson = async (response: Response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export class QuickBooksClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly minorVersion: string;
  private tokens: OAuthTokens;

  constructor(
    private readonly context: ServiceContext,
    options?: { fetchFn?: FetchFn; minorVersion?: string },
  ) {
    const env = context.env as ServiceContext["env"] & {
      QBO_API_BASE_URL?: string;
      QBO_TOKEN_URL?: string;
      QBO_ACCESS_TOKEN?: string;
      QBO_REFRESH_TOKEN?: string;
    };

    this.fetchFn = options?.fetchFn ?? fetch;
    this.baseUrl = env.QBO_API_BASE_URL ?? defaultBaseUrl(env);
    this.tokenUrl = env.QBO_TOKEN_URL ?? defaultTokenUrl();
    this.minorVersion = options?.minorVersion ?? DEFAULT_MINOR_VERSION;

    const accessToken = env.QBO_ACCESS_TOKEN ?? null;
    const refreshToken = env.QBO_REFRESH_TOKEN ?? null;
    const expiresAt = accessToken
      ? Date.now() + DEFAULT_ACCESS_TOKEN_TTL
      : 0;

    this.tokens = {
      accessToken,
      refreshToken,
      expiresAt,
    };
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.tokens.refreshToken) {
      throw new Error("QuickBooks refresh token is not configured");
    }

    const headers = {
      Authorization: `Basic ${encodeBasicAuth(
        this.context.env.QBO_CLIENT_ID,
        this.context.env.QBO_CLIENT_SECRET,
      )}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
    }).toString();

    const response = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const payload = await parseJson(response);
      throw new Error(
        `Failed to refresh QuickBooks token: ${response.status} ${JSON.stringify(payload)}`,
      );
    }

    const payload = (await parseJson(response)) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    } | null;

    if (!payload || typeof payload.access_token !== "string") {
      throw new Error("Invalid token response from QuickBooks");
    }

    this.tokens.accessToken = payload.access_token;
    if (payload.refresh_token) {
      this.tokens.refreshToken = payload.refresh_token;
    }

    const expiresInMs =
      typeof payload.expires_in === "number"
        ? payload.expires_in * 1000
        : DEFAULT_ACCESS_TOKEN_TTL;

    this.tokens.expiresAt = Date.now() + expiresInMs;

    return this.tokens.accessToken;
  }

  private async ensureAccessToken(): Promise<string> {
    const now = Date.now();
    if (
      this.tokens.accessToken &&
      now < this.tokens.expiresAt - DEFAULT_EXPIRATION_BUFFER
    ) {
      return this.tokens.accessToken;
    }

    if (!this.tokens.refreshToken && this.tokens.accessToken) {
      return this.tokens.accessToken;
    }

    return this.refreshAccessToken();
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    const token = await this.ensureAccessToken();
    const url = new URL(`${this.baseUrl}${path}`);

    url.searchParams.set("minorversion", this.minorVersion);

    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    let body: string | undefined;

    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await this.fetchFn(url.toString(), {
      method,
      headers,
      body,
    });

    if (response.status === 401 && options?.retry !== false) {
      this.tokens.expiresAt = 0;
      await this.refreshAccessToken();
      return this.request<T>(method, path, { ...options, retry: false });
    }

    const payload = await parseJson(response);

    if (!response.ok) {
      throw new Error(
        `QuickBooks request failed: ${response.status} ${JSON.stringify(payload)}`,
      );
    }

    return payload as T;
  }

  async findByDocNumber<T extends QboDocType>(
    docType: T,
    docNumber: string,
  ): Promise<({ Id: string } & Record<string, unknown>) | null> {
    const sanitized = docNumber.replace(/'/g, "''");
    const query = `select * from ${docType} where DocNumber = '${sanitized}'`;
    const result = await this.request<QueryResponse<{ Id: string }>>(
      "GET",
      `/v3/company/${this.context.env.QBO_REALM_ID}/query`,
      { query: { query } },
    );

    const entries = result.QueryResponse?.[docType];
    if (Array.isArray(entries) && entries.length > 0) {
      return entries[0];
    }

    return null;
  }

  private async createEntity<T extends QboDocType>(
    docType: T,
    payload: Record<string, unknown>,
  ): Promise<{ Id: string } & Record<string, unknown>> {
    const path = `/v3/company/${this.context.env.QBO_REALM_ID}/${docTypePath[docType]}`;
    const result = await this.request<CreatedEntity<T>>("POST", path, {
      body: payload,
    });

    if (result && typeof result === "object") {
      if (docType in result && result[docType as keyof typeof result]) {
        const entity = result[docType as keyof typeof result];
        if (entity && typeof entity === "object" && "Id" in entity) {
          return entity as { Id: string } & Record<string, unknown>;
        }
      }

      if ("Id" in result) {
        return result as { Id: string } & Record<string, unknown>;
      }
    }

    throw new Error(`Unexpected QuickBooks response for ${docType}`);
  }

  createSalesReceipt(payload: Record<string, unknown>) {
    return this.createEntity("SalesReceipt", payload);
  }

  createRefundReceipt(payload: Record<string, unknown>) {
    return this.createEntity("RefundReceipt", payload);
  }

  createJournalEntry(payload: Record<string, unknown>) {
    return this.createEntity("JournalEntry", payload);
  }

  createTransfer(payload: Record<string, unknown>) {
    return this.createEntity("Transfer", payload);
  }
}

export const createQboClient = (
  context: ServiceContext,
  options?: { fetchFn?: FetchFn; minorVersion?: string },
): QuickBooksClient => new QuickBooksClient(context, options);
