import { EnvValidationError, getCachedEnv } from "../../config/env";
import { createLogger } from "../../services/shared/logger";

interface AzureHttpRequest {
  headers?: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  url?: string;
}

interface AzureHttpResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface AzureContext {
  invocationId: string;
  res?: AzureHttpResponse;
}

type AzureFunctionHandler = (
  context: AzureContext,
  req: AzureHttpRequest,
) => Promise<void>;

const logger = createLogger("app:oauthCallback");

const getCorrelationId = (
  req: AzureHttpRequest,
  context: AzureContext,
): string =>
  req.headers?.["x-correlation-id"] ??
  req.headers?.["X-Correlation-Id"] ??
  context.invocationId;

const formatEnvIssues = (issues: EnvValidationError["issues"]): string[] =>
  issues.map((issue) => {
    const path = issue.path.join(".") || "env";
    return `${path}: ${issue.message}`;
  });

const getQueryValue = (
  req: AzureHttpRequest,
  key: string,
): string | undefined => req.query?.[key];

const deriveRedirectUri = (req: AzureHttpRequest): string | undefined => {
  if (req.url) {
    try {
      const parsed = new URL(req.url);
      parsed.hash = "";
      parsed.search = "";
      return parsed.toString();
    } catch (error) {
      logger.warn("Failed to parse request url for redirect uri", { error });
    }
  }

  const host =
    req.headers?.["x-forwarded-host"] ?? req.headers?.["host"] ?? undefined;
  if (!host) {
    return undefined;
  }

  const protoHeader =
    req.headers?.["x-forwarded-proto"] ?? req.headers?.["X-Forwarded-Proto"];
  const protocol = protoHeader ?? (host.includes("localhost") ? "http" : "https");

  return `${protocol}://${host}/api/oauth/callback`;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });

const formatHtml = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
      body { margin: 2rem auto; max-width: 720px; color: #1f2933; }
      header { margin-bottom: 1.5rem; }
      pre {
        background: #f1f5f9;
        padding: 1rem;
        border-radius: 0.5rem;
        overflow-x: auto;
      }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .notice {
        padding: 1rem;
        border-radius: 0.5rem;
        background: #fef3c7;
        border: 1px solid #f59e0b;
      }
      a { color: #2563eb; }
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>`;

const successBody = (
  tokens: Record<string, unknown>,
  redirectUri: string,
  state?: string,
) => {
  const filtered = Object.fromEntries(
    Object.entries(tokens).filter(([, value]) => value !== undefined),
  );

  const payload = {
    redirect_uri: redirectUri,
    state: state ?? null,
    ...filtered,
  };

  const serialized = escapeHtml(JSON.stringify(payload, null, 2));

  return formatHtml(
    "Salesforce OAuth Complete",
    `<header>
      <h1>Salesforce connection established</h1>
      <p>
        Copy the values below and store them securely. You will need the
        <code>refresh_token</code> (if provided) and <code>instance_url</code> to
        configure the integration.
      </p>
    </header>
    <section>
      <h2>Token response</h2>
      <pre>${serialized}</pre>
    </section>
    <section class="notice">
      <p>
        The access token is short-lived. Ensure the refresh token is stored in a
        secure secret store (Key Vault, environment variable, etc.) and update
        your configuration accordingly.
      </p>
    </section>`,
  );
};

const errorBody = (title: string, message: string) =>
  formatHtml(
    title,
    `<header>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </header>`,
  );

const parseJson = (input: string): unknown => {
  if (!input) {
    return {};
  }

  try {
    return JSON.parse(input);
  } catch {
    return { raw: input };
  }
};

const exchangeSalesforceCode = async (
  params: {
    loginUrl: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
  requestLogger: ReturnType<typeof createLogger>,
): Promise<Record<string, unknown>> => {
  const tokenEndpoint = `${params.loginUrl.replace(/\/+$/u, "")}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });

  requestLogger.debug("Exchanging Salesforce authorization code");

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    requestLogger.error("Salesforce token exchange failed", {
      status: response.status,
      payload,
    });
    throw new Error(
      `Salesforce token exchange failed: ${response.status} ${JSON.stringify(payload)}`,
    );
  }

  if (!payload || typeof payload !== "object") {
    requestLogger.error("Unexpected Salesforce token payload", { payload });
    throw new Error("Invalid token response from Salesforce");
  }

  return payload as Record<string, unknown>;
};

export const oauthCallbackHandler: AzureFunctionHandler = async (
  context,
  req,
): Promise<void> => {
  const correlationId = getCorrelationId(req, context);
  const requestLogger = logger.child({
    correlationId,
    invocationId: context.invocationId,
  });

  let env: ReturnType<typeof getCachedEnv>;

  try {
    env = getCachedEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      const details = formatEnvIssues(error.issues);
      requestLogger.error("Invalid environment configuration", {
        details,
      });
      context.res = {
        status: 500,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
        body: errorBody(
          "Configuration error",
          "Salesforce OAuth cannot proceed due to invalid environment variables.",
        ),
      };
      return;
    }

    requestLogger.error("Failed to read environment configuration", { error });
    context.res = {
      status: 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: errorBody(
        "Configuration error",
        error instanceof Error ? error.message : String(error),
      ),
    };
    return;
  }

  const oauthError = getQueryValue(req, "error");
  if (oauthError) {
    const description =
      getQueryValue(req, "error_description") ??
      "Salesforce returned an error during authorization.";
    requestLogger.warn("Received Salesforce OAuth error", {
      error: oauthError,
      description,
    });
    context.res = {
      status: 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: errorBody(
        "Salesforce authorization failed",
        `${oauthError}: ${description}`,
      ),
    };
    return;
  }

  const code = getQueryValue(req, "code");
  if (!code) {
    requestLogger.warn("Missing authorization code in callback");
    context.res = {
      status: 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: errorBody(
        "Missing authorization code",
        "The Salesforce callback did not include an authorization code.",
      ),
    };
    return;
  }

  const state = getQueryValue(req, "state");
  const envRecord = env as Record<string, unknown>;
  const configuredLoginUrl =
    typeof envRecord.SF_LOGIN_URL === "string" && envRecord.SF_LOGIN_URL.trim()
      ? envRecord.SF_LOGIN_URL.trim()
      : undefined;
  const loginUrl = configuredLoginUrl ?? "https://login.salesforce.com";

  const configuredRedirectUri =
    typeof envRecord.SF_OAUTH_REDIRECT_URI === "string" &&
    envRecord.SF_OAUTH_REDIRECT_URI.trim()
      ? envRecord.SF_OAUTH_REDIRECT_URI.trim()
      : undefined;

  const redirectUri = configuredRedirectUri ?? deriveRedirectUri(req);
  if (!redirectUri) {
    requestLogger.error("Unable to determine redirect URI for token exchange");
    context.res = {
      status: 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: errorBody(
        "Redirect URI unavailable",
        "Could not determine the redirect URI required for the Salesforce token exchange.",
      ),
    };
    return;
  }

  try {
    const tokens = await exchangeSalesforceCode(
      {
        loginUrl,
        clientId: env.SF_CLIENT_ID,
        clientSecret: env.SF_CLIENT_SECRET,
        code,
        redirectUri,
      },
      requestLogger,
    );

    requestLogger.info("Salesforce OAuth flow completed");

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: successBody(tokens, redirectUri, state ?? undefined),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    requestLogger.error("Salesforce OAuth callback failed", { message });

    context.res = {
      status: 502,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: errorBody(
        "Salesforce OAuth failed",
        "We were unable to exchange the authorization code for tokens. Check the application logs for more details.",
      ),
    };
  }
};

export default oauthCallbackHandler;
