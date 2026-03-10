import { z } from 'zod';

type SalesforceAuthMode = 'disabled' | 'client-credentials';
type QuickBooksEnvironment = 'sandbox' | 'production';
type AccountingPostingStrategy = 'je-transfer' | 'sales-receipt';

export interface EnvConfig {
  stripe: {
    secret: string;
    webhookSecret: string;
  };
  testMode: boolean;
  salesforce: {
    authMode: SalesforceAuthMode;
    clientId?: string;
    clientSecret?: string;
    loginUrl: string;
  };
  quickBooks: {
    environment: QuickBooksEnvironment;
    realmId?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
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
    defaultSalesItem: string;
    accounts: {
      autoCreate: boolean;
      types: {
        stripeClearing: { accountType: string; accountSubType: string };
        operatingBank: { accountType: string; accountSubType: string };
        revenue: { accountType: string; accountSubType: string };
        fees: { accountType: string; accountSubType: string };
        refunds: { accountType: string; accountSubType: string };
        disputeLosses: { accountType: string; accountSubType: string };
      };
    };
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

  throw new EnvConfigError(
    `Invalid boolean value for ${name}: ${value}. Expected "true" or "false".`
  );
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
    missing.push(
      'STRIPE_WEBHOOK_SECRET (or STRIPE_WEBHOOK_SECRET_LIVE / STRIPE_WEBHOOK_SECRET_TEST)'
    );
  }

  const authModeEnvValue = resolveEnv('SF_AUTH_MODE', {
    fallbackNames: ['SALESFORCE_AUTH_MODE'],
    defaultValue: 'disabled',
  });
  const authModeExplicitlySet = Boolean(
    process.env.SF_AUTH_MODE ?? process.env.SALESFORCE_AUTH_MODE
  );
  const salesforceClientId = resolveEnv('SF_CLIENT_ID', {
    fallbackNames: ['SALESFORCE_CLIENT_ID'],
  });
  const salesforceClientSecret = resolveEnv('SF_CLIENT_SECRET', {
    fallbackNames: ['SALESFORCE_CLIENT_SECRET'],
  });

  let resolvedSalesforceAuthMode: SalesforceAuthMode = (
    authModeEnvValue ?? 'disabled'
  ).toLowerCase() as SalesforceAuthMode;

  if (
    !authModeExplicitlySet &&
    resolvedSalesforceAuthMode === 'disabled' &&
    salesforceClientId &&
    salesforceClientSecret
  ) {
    resolvedSalesforceAuthMode = 'client-credentials';
  }

  const salesforceRaw = {
    authMode: resolvedSalesforceAuthMode,
    clientId: salesforceClientId,
    clientSecret: salesforceClientSecret,
    loginUrl:
      resolveEnv('SF_LOGIN_URL', {
        fallbackNames: ['SALESFORCE_LOGIN_URL'],
        defaultValue: DEFAULT_SALESFORCE_LOGIN_URL,
      }) ?? DEFAULT_SALESFORCE_LOGIN_URL,
  };

  const salesforceSchema = z.object({
    authMode: z.enum(['disabled', 'client-credentials'] as const),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    loginUrl: z.string().url(),
  });

  const salesforce = salesforceSchema.parse(salesforceRaw);

  if (salesforce.authMode === 'client-credentials') {
    if (!salesforce.clientId) {
      missing.push('SF_CLIENT_ID (or SALESFORCE_CLIENT_ID)');
    }
    if (!salesforce.clientSecret) {
      missing.push('SF_CLIENT_SECRET (or SALESFORCE_CLIENT_SECRET)');
    }
  }

  const quickBooksRaw = {
    environment: (
      resolveEnv('QBO_ENV', {
        fallbackNames: ['QBO_ENVIRONMENT'],
        defaultValue: 'sandbox',
      }) ?? 'sandbox'
    ).toLowerCase(),
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
    redirectUri: z.string().url().optional(),
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

  const postingStrategy = postingStrategySchema.safeParse(
    (postingStrategyRaw ?? 'je-transfer').toLowerCase()
  );
  if (!postingStrategy.success) {
    errors.push('ACCOUNTING_POSTING_STRATEGY must be one of: "je-transfer", "sales-receipt".');
  }

  const accountingSyncEnabledRaw = resolveEnv('ACCOUNTING_SYNC_ENABLED', {
    defaultValue: 'false',
  });
  const syncEnabled = parseBoolean('ACCOUNTING_SYNC_ENABLED', accountingSyncEnabledRaw, false);

  const defaultSalesItem =
    resolveEnv('QBO_DEFAULT_SALES_ITEM', {
      fallbackNames: ['ACCOUNTING_DEFAULT_SALES_ITEM'],
      defaultValue: 'Stripe Transaction',
    }) ?? 'Stripe Transaction';

  const autoCreateAccountsRaw = resolveEnv('ACCOUNTING_AUTOCREATE_ACCOUNTS', {
    defaultValue: 'true',
  });
  const autoCreateAccounts = parseBoolean(
    'ACCOUNTING_AUTOCREATE_ACCOUNTS',
    autoCreateAccountsRaw,
    true
  );

  // Account type configurations
  const accountTypes = {
    stripeClearing: {
      accountType:
        resolveEnv('ACCOUNTING_STRIPE_CLEARING_ACCOUNT_TYPE', {
          defaultValue: 'Bank',
        }) ?? 'Bank',
      accountSubType:
        resolveEnv('ACCOUNTING_STRIPE_CLEARING_ACCOUNT_SUBTYPE', {
          defaultValue: 'CashOnHand',
        }) ?? 'CashOnHand',
    },
    operatingBank: {
      accountType:
        resolveEnv('ACCOUNTING_OPERATING_BANK_ACCOUNT_TYPE', {
          defaultValue: 'Bank',
        }) ?? 'Bank',
      accountSubType:
        resolveEnv('ACCOUNTING_OPERATING_BANK_ACCOUNT_SUBTYPE', {
          defaultValue: 'Checking',
        }) ?? 'Checking',
    },
    revenue: {
      accountType:
        resolveEnv('ACCOUNTING_REVENUE_ACCOUNT_TYPE', {
          defaultValue: 'Income',
        }) ?? 'Income',
      accountSubType:
        resolveEnv('ACCOUNTING_REVENUE_ACCOUNT_SUBTYPE', {
          defaultValue: 'ServiceFeeIncome',
        }) ?? 'ServiceFeeIncome',
    },
    fees: {
      accountType:
        resolveEnv('ACCOUNTING_FEES_ACCOUNT_TYPE', {
          defaultValue: 'Expense',
        }) ?? 'Expense',
      accountSubType:
        resolveEnv('ACCOUNTING_FEES_ACCOUNT_SUBTYPE', {
          defaultValue: 'OtherMiscellaneousExpense',
        }) ?? 'OtherMiscellaneousExpense',
    },
    refunds: {
      accountType:
        resolveEnv('ACCOUNTING_REFUNDS_ACCOUNT_TYPE', {
          defaultValue: 'Expense',
        }) ?? 'Expense',
      accountSubType:
        resolveEnv('ACCOUNTING_REFUNDS_ACCOUNT_SUBTYPE', {
          defaultValue: 'OtherMiscellaneousExpense',
        }) ?? 'OtherMiscellaneousExpense',
    },
    disputeLosses: {
      accountType:
        resolveEnv('ACCOUNTING_DISPUTE_LOSSES_ACCOUNT_TYPE', {
          defaultValue: 'Expense',
        }) ?? 'Expense',
      accountSubType:
        resolveEnv('ACCOUNTING_DISPUTE_LOSSES_ACCOUNT_SUBTYPE', {
          defaultValue: 'OtherMiscellaneousExpense',
        }) ?? 'OtherMiscellaneousExpense',
    },
  };

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
  }

  const appInsightsInstrumentationKey = resolveEnv('APPINSIGHTS_INSTRUMENTATIONKEY', {
    fallbackNames: ['APPINSIGHTS_INSTRUMENTATION_KEY'],
  });

  const testModeRaw = resolveEnv('TEST_MODE', {
    defaultValue: 'false',
  });
  const testMode = parseBoolean('TEST_MODE', testModeRaw, false);

  if (missing.length > 0) {
    throw new EnvConfigError(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new EnvConfigError(errors.join(' '));
  }

  return {
    stripe: {
      secret: stripeSecret!,
      webhookSecret: stripeWebhookSecret!,
    },
    testMode,
    salesforce: {
      authMode: salesforce.authMode,
      clientId: salesforce.clientId,
      clientSecret: salesforce.clientSecret,
      loginUrl: salesforce.loginUrl,
    },
    quickBooks: {
      environment: quickBooks.environment,
      realmId: quickBooks.realmId,
      clientId: quickBooks.clientId,
      clientSecret: quickBooks.clientSecret,
      redirectUri: quickBooks.redirectUri,
      refreshToken: quickBooks.refreshToken,
      accounts: quickBooks.accounts,
    },
    accounting: {
      postingStrategy: (postingStrategy.success
        ? postingStrategy.data
        : 'je-transfer') as AccountingPostingStrategy,
      syncEnabled,
      defaultSalesItem,
      accounts: {
        autoCreate: autoCreateAccounts,
        types: accountTypes,
      },
    },
    appInsights: appInsightsInstrumentationKey
      ? { instrumentationKey: appInsightsInstrumentationKey }
      : undefined,
  };
}

export const env = loadEnv();

export default env;
