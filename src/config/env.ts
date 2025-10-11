import { z } from 'zod';

type SalesforceAuthMode = 'disabled' | 'jwt' | 'username-password';
type QuickBooksEnvironment = 'sandbox' | 'production';
type AccountingPostingStrategy = 'je-transfer' | 'sales-receipt';

export interface EnvConfig {
  stripe: {
    secret: string;
    webhookSecret: string;
  };
  salesforce: {
    authMode: SalesforceAuthMode;
    clientId?: string;
    username?: string;
    loginUrl: string;
    jwtPrivateKey?: string;
  };
  quickBooks: {
    environment: QuickBooksEnvironment;
    realmId?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    accounts: {
      stripeClearing: string;
      operatingBank: string;
      revenue: string;
      fees: string;
      refunds: string;
      disputeLosses: string;
    };
    items?: {
      revenue?: string;
    };
  };
  accounting: {
    postingStrategy: AccountingPostingStrategy;
    syncEnabled: boolean;
  };
  appInsights?: {
    instrumentationKey: string;
  };
}

class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

type ResolveOptions = {
  fallbackNames?: string[];
  defaultValue?: string;
  trim?: boolean;
};

const DEFAULT_SALESFORCE_LOGIN_URL = 'https://login.salesforce.com';

function resolveEnv(name: string, options: ResolveOptions = {}): string | undefined {
  const { fallbackNames = [], defaultValue, trim = true } = options;
  const candidates = [name, ...fallbackNames];

  for (const candidate of candidates) {
    const raw = process.env[candidate];
    if (typeof raw === 'string') {
      const value = trim ? raw.trim() : raw;
      if (value.length > 0) {
        return value;
      }
    }
  }

  return defaultValue;
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value === 'undefined') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new EnvConfigError(`Invalid boolean value for ${name}: ${value}. Expected "true" or "false".`);
}

function loadEnv(): EnvConfig {
  const missing: string[] = [];
  const errors: string[] = [];

  const stripeSecret = resolveEnv('STRIPE_SECRET', {
    fallbackNames: ['STRIPE_LIVE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY'],
  });
  if (!stripeSecret) {
    missing.push('STRIPE_SECRET (or STRIPE_LIVE_SECRET_KEY / STRIPE_TEST_SECRET_KEY)');
  }

  const stripeWebhookSecret = resolveEnv('STRIPE_WEBHOOK_SECRET', {
    fallbackNames: ['STRIPE_WEBHOOK_SECRET_LIVE', 'STRIPE_WEBHOOK_SECRET_TEST'],
  });
  if (!stripeWebhookSecret) {
    missing.push('STRIPE_WEBHOOK_SECRET (or STRIPE_WEBHOOK_SECRET_LIVE / STRIPE_WEBHOOK_SECRET_TEST)');
  }

  const salesforceRaw = {
    authMode: (resolveEnv('SF_AUTH_MODE', {
      fallbackNames: ['SALESFORCE_AUTH_MODE'],
      defaultValue: 'disabled',
    }) ?? 'disabled').toLowerCase(),
    clientId: resolveEnv('SF_CLIENT_ID', {
      fallbackNames: ['SALESFORCE_CLIENT_ID'],
    }),
    username: resolveEnv('SF_USERNAME', {
      fallbackNames: ['SALESFORCE_USERNAME'],
    }),
    loginUrl:
      resolveEnv('SF_LOGIN_URL', {
        fallbackNames: ['SALESFORCE_LOGIN_URL'],
        defaultValue: DEFAULT_SALESFORCE_LOGIN_URL,
      }) ?? DEFAULT_SALESFORCE_LOGIN_URL,
    jwtPrivateKey: resolveEnv('SF_JWT_PRIVATE_KEY', {
      fallbackNames: ['SALESFORCE_JWT_PRIVATE_KEY'],
      trim: false,
    }),
  };

  const salesforceSchema = z.object({
    authMode: z.enum(['disabled', 'jwt', 'username-password'] as const),
    clientId: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    loginUrl: z.string().url(),
    jwtPrivateKey: z.string().min(1).optional(),
  });

  const salesforce = salesforceSchema.parse(salesforceRaw);

  if (salesforce.authMode === 'jwt') {
    if (!salesforce.clientId) {
      missing.push('SF_CLIENT_ID');
    }
    if (!salesforce.username) {
      missing.push('SF_USERNAME');
    }
    if (!salesforce.jwtPrivateKey) {
      missing.push('SF_JWT_PRIVATE_KEY');
    }
  }

  const quickBooksRaw = {
    environment: (resolveEnv('QBO_ENV', {
      fallbackNames: ['QBO_ENVIRONMENT'],
      defaultValue: 'sandbox',
    }) ?? 'sandbox').toLowerCase(),
    realmId: resolveEnv('QBO_REALM_ID', {
      fallbackNames: ['QBO_COMPANY_ID'],
    }),
    clientId: resolveEnv('QBO_CLIENT_ID'),
    clientSecret: resolveEnv('QBO_CLIENT_SECRET'),
    refreshToken: resolveEnv('QBO_REFRESH_TOKEN'),
    accounts: {
      stripeClearing:
        resolveEnv('QBO_ACCOUNT_STRIPE_CLEARING', {
          fallbackNames: ['ACCOUNTING_STRIPE_CLEARING_ACCOUNT'],
          defaultValue: 'Stripe Clearing',
        }) ?? 'Stripe Clearing',
      operatingBank:
        resolveEnv('QBO_ACCOUNT_OPERATING_BANK', {
          fallbackNames: ['ACCOUNTING_OPERATING_BANK_ACCOUNT'],
          defaultValue: 'Operating Bank',
        }) ?? 'Operating Bank',
      revenue:
        resolveEnv('QBO_ACCOUNT_REVENUE', {
          fallbackNames: ['ACCOUNTING_REVENUE_ACCOUNT'],
          defaultValue: 'Revenue',
        }) ?? 'Revenue',
      fees:
        resolveEnv('QBO_ACCOUNT_FEES', {
          fallbackNames: ['ACCOUNTING_STRIPE_FEE_ACCOUNT'],
          defaultValue: 'Stripe Fees',
        }) ?? 'Stripe Fees',
      refunds:
        resolveEnv('QBO_ACCOUNT_REFUNDS', {
          fallbackNames: ['ACCOUNTING_REFUNDS_ACCOUNT'],
          defaultValue: 'Refunds',
        }) ?? 'Refunds',
      disputeLosses:
        resolveEnv('QBO_ACCOUNT_DISPUTES', {
          fallbackNames: ['ACCOUNTING_DISPUTE_LOSS_ACCOUNT'],
          defaultValue: 'Dispute Losses',
        }) ?? 'Dispute Losses',
    },
  };

  const quickBooksSchema = z.object({
    environment: z.enum(['sandbox', 'production'] as const),
    realmId: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    accounts: z.object({
      stripeClearing: z.string().min(1),
      operatingBank: z.string().min(1),
      revenue: z.string().min(1),
      fees: z.string().min(1),
      refunds: z.string().min(1),
      disputeLosses: z.string().min(1),
    }),
  });

  const quickBooks = quickBooksSchema.parse(quickBooksRaw);

  const postingStrategyRaw = resolveEnv('ACCOUNTING_POSTING_STRATEGY', {
    defaultValue: 'je-transfer',
  });
  const postingStrategySchema = z.enum(['je-transfer', 'sales-receipt'] as const);

  const postingStrategy = postingStrategySchema.safeParse((postingStrategyRaw ?? 'je-transfer').toLowerCase());
  if (!postingStrategy.success) {
    errors.push(
      'ACCOUNTING_POSTING_STRATEGY must be one of: "je-transfer", "sales-receipt".'
    );
  }

  const accountingSyncEnabledRaw = resolveEnv('ACCOUNTING_SYNC_ENABLED', {
    defaultValue: 'false',
  });
  const syncEnabled = parseBoolean('ACCOUNTING_SYNC_ENABLED', accountingSyncEnabledRaw, false);

  if (syncEnabled) {
    if (!quickBooks.realmId) {
      missing.push('QBO_REALM_ID');
    }
    if (!quickBooks.clientId) {
      missing.push('QBO_CLIENT_ID');
    }
    if (!quickBooks.clientSecret) {
      missing.push('QBO_CLIENT_SECRET');
    }
    if (!quickBooks.refreshToken) {
      missing.push('QBO_REFRESH_TOKEN');
    }
  }

  const appInsightsInstrumentationKey = resolveEnv('APPINSIGHTS_INSTRUMENTATIONKEY', {
    fallbackNames: ['APPINSIGHTS_INSTRUMENTATION_KEY'],
  });

  if (missing.length > 0) {
    throw new EnvConfigError(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  if (errors.length > 0) {
    throw new EnvConfigError(errors.join(' '));
  }

  return {
    stripe: {
      secret: stripeSecret!,
      webhookSecret: stripeWebhookSecret!,
    },
    salesforce: {
      authMode: salesforce.authMode,
      clientId: salesforce.clientId,
      username: salesforce.username,
      loginUrl: salesforce.loginUrl,
      jwtPrivateKey: salesforce.jwtPrivateKey,
    },
    quickBooks: {
      environment: quickBooks.environment,
      realmId: quickBooks.realmId,
      clientId: quickBooks.clientId,
      clientSecret: quickBooks.clientSecret,
      refreshToken: quickBooks.refreshToken,
      accounts: quickBooks.accounts,
    },
    accounting: {
      postingStrategy: (postingStrategy.success
        ? postingStrategy.data
        : 'je-transfer') as AccountingPostingStrategy,
      syncEnabled,
    },
    appInsights: appInsightsInstrumentationKey
      ? { instrumentationKey: appInsightsInstrumentationKey }
      : undefined,
  };
}

export const env = loadEnv();

export default env;
