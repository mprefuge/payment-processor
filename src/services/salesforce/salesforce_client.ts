import { IncomingHttpHeaders } from "node:http";
import http from "node:http";
import https from "node:https";
import { URL, URLSearchParams } from "node:url";

export interface SalesforceClientOptions {
  loginUrl?: string;
  apiVersion?: string;
}

export interface SalesforceCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface SalesforceAuthResponse {
  access_token: string;
  instance_url: string;
  token_type: string;
}

export interface SalesforceQueryResult<T> {
  totalSize: number;
  done: boolean;
  records: T[];
}

export interface SalesforceUpsertResult {
  id: string;
  action: "created" | "updated";
}

type RequestOptions = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

interface RawResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export class SalesforceClient {
  private readonly loginUrl: string;
  private readonly apiVersion: string;
  private accessToken: string | null = null;
  private instanceUrl: string | null = null;

  constructor(
    private readonly credentials: SalesforceCredentials,
    options: SalesforceClientOptions = {},
  ) {
    this.loginUrl = options.loginUrl ?? "https://login.salesforce.com";
    this.apiVersion = options.apiVersion ?? "v59.0";
  }

  private async performRequest({ method, url, headers, body }: RequestOptions) {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;

    const requestOptions: https.RequestOptions = {
      method,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers,
    };

    return new Promise<RawResponse>((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });

      req.on("error", reject);

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  private async authenticate() {
    const params = new URLSearchParams({
      grant_type: "password",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      username: this.credentials.username,
      password: this.credentials.password,
    });

    const response = await this.performRequest({
      method: "POST",
      url: `${this.loginUrl}/services/oauth2/token`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Failed to authenticate with Salesforce: ${response.statusCode} ${response.body}`,
      );
    }

    const payload = JSON.parse(response.body) as SalesforceAuthResponse;
    this.accessToken = payload.access_token;
    this.instanceUrl = payload.instance_url;
  }

  private async ensureSession() {
    if (!this.accessToken || !this.instanceUrl) {
      await this.authenticate();
    }
  }

  private async requestWithAuth(
    options: Omit<RequestOptions, "url"> & { path: string },
  ): Promise<RawResponse> {
    await this.ensureSession();
    const url = `${this.instanceUrl}${options.path}`;

    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    };

    const response = await this.performRequest({
      method: options.method,
      url,
      headers,
      body: options.body,
    });

    if (response.statusCode === 401) {
      this.accessToken = null;
      await this.ensureSession();
      return this.requestWithAuth(options);
    }

    return response;
  }

  private apiPath(resource: string) {
    return `/services/data/${this.apiVersion}${resource}`;
  }

  async query<T>(soql: string): Promise<SalesforceQueryResult<T>> {
    const response = await this.requestWithAuth({
      method: "GET",
      path: this.apiPath(`/query?q=${encodeURIComponent(soql)}`),
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Salesforce query failed: ${response.statusCode} ${response.body}`);
    }

    return JSON.parse(response.body) as SalesforceQueryResult<T>;
  }

  private async retrieveByExternalId(
    objectName: string,
    externalIdField: string,
    externalIdValue: string,
  ) {
    const path =
      externalIdField === "Id"
        ? this.apiPath(`/sobjects/${objectName}/${encodeURIComponent(externalIdValue)}`)
        : this.apiPath(
            `/sobjects/${objectName}/${externalIdField}/${encodeURIComponent(externalIdValue)}`,
          );

    const response = await this.requestWithAuth({
      method: "GET",
      path,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Salesforce retrieve failed: ${response.statusCode} ${response.body}`,
      );
    }

    return JSON.parse(response.body) as { Id: string };
  }

  async upsert(
    objectName: string,
    externalIdField: string,
    externalIdValue: string,
    payload: Record<string, unknown>,
  ): Promise<SalesforceUpsertResult> {
    const path =
      externalIdField === "Id"
        ? this.apiPath(`/sobjects/${objectName}/${encodeURIComponent(externalIdValue)}`)
        : this.apiPath(
            `/sobjects/${objectName}/${externalIdField}/${encodeURIComponent(externalIdValue)}`,
          );

    const response = await this.requestWithAuth({
      method: "PATCH",
      path,
      body: JSON.stringify(payload),
    });

    if (response.statusCode === 201 || response.statusCode === 200) {
      const body = JSON.parse(response.body) as { id: string };
      return { id: body.id, action: "created" };
    }

    if (response.statusCode === 204) {
      const record = await this.retrieveByExternalId(
        objectName,
        externalIdField,
        externalIdValue,
      );
      return { id: record.Id, action: "updated" };
    }

    throw new Error(
      `Salesforce upsert failed: ${response.statusCode} ${response.body}`,
    );
  }
}
