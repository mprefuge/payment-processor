import jsforce from 'jsforce';
import type { Connection } from 'jsforce/lib/connection';

const DEFAULT_SALESFORCE_LOGIN_URL = 'https://login.salesforce.com';

export type SalesforceServiceConfig = {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
};

type SalesforceClientCredentialsTokenResponse = {
  access_token: string;
  instance_url: string;
  token_type?: string;
};

const normalizeLoginUrl = (loginUrl: string): string => loginUrl.replace(/\/+$/, '');

export const buildSalesforceConfig = (): SalesforceServiceConfig => ({
  loginUrl: (process.env.SF_LOGIN_URL || DEFAULT_SALESFORCE_LOGIN_URL).trim(),
  clientId: (process.env.SF_CLIENT_ID || '').trim(),
  clientSecret: (process.env.SF_CLIENT_SECRET || '').trim(),
});

export class SalesforceService {
  private readonly config: SalesforceServiceConfig;

  private connection: Connection | null = null;

  constructor(config: SalesforceServiceConfig) {
    this.config = {
      loginUrl: normalizeLoginUrl(config.loginUrl || DEFAULT_SALESFORCE_LOGIN_URL),
      clientId: (config.clientId || '').trim(),
      clientSecret: (config.clientSecret || '').trim(),
    };
  }

  async authenticate(): Promise<Connection> {
    if (this.connection?.accessToken) {
      return this.connection;
    }

    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error('Salesforce client credentials are not configured.');
    }

    const tokenEndpoint = `${this.config.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new Error(
        `Salesforce client-credentials authentication failed (${response.status}): ${raw}`
      );
    }

    const token = (await response.json()) as SalesforceClientCredentialsTokenResponse;

    if (!token?.access_token || !token?.instance_url) {
      throw new Error('Salesforce authentication response is missing access_token or instance_url.');
    }

    const connection = new jsforce.Connection({
      loginUrl: this.config.loginUrl,
      instanceUrl: token.instance_url,
      accessToken: token.access_token,
    });

    this.connection = connection;

    return connection;
  }
}
