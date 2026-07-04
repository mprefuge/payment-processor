import { z } from 'zod';

import {
  DEFAULT_SALESFORCE_LOGIN_URL,
  EnvConfigError,
  normalizeQboEnvironment,
  parseBoolean,
  resolveEnv,
  type QuickBooksEnvironment,
} from './env/resolve';

export { DEFAULT_SALESFORCE_LOGIN_URL } from './env/resolve';

type SalesforceAuthMode = 'disabled' | 'client-credentials';
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
}

// Shared accumulator: each loader records missing/invalid vars so the composer
// can throw once, reporting every problem together (not just the first).
interface LoadContext {
  missing: string[];
  errors: string[];
}

function loadStripe(ctx: LoadContext): EnvConfig['stripe'] {
  const secret = resolveEnv('STRIPE_SECRET', {
    fallbackNames: ['STRIPE_LIVE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY'],
  });
  if (!secret) {
    ctx.missing.push('STRIPE_SECRET (or STRIPE_LIVE_SECRET_KEY / STRIPE_TEST_SECRET_KEY)');
  }

  const webhookSecret = resolveEnv('STRIPE_WEBHOOK_SECRET', {
    fallbackNames: ['STRIPE_WEBHOOK_SECRET_LIVE', 'STRIPE_WEBHOOK_SECRET_TEST'],
  });
  if (!webhookSecret) {
    ctx.missing.push(
      'STRIPE_WEBHOOK_SECRET (or STRIPE_WEBHOOK_SECRET_LIVE / STRIPE_WEBHOOK_SECRET_TEST)'
    );
  }

  return { secret: secret ?? '', webhookSecret: webhookSecret ?? '' };
}

function loadSalesforce(ctx: LoadContext): EnvConfig['salesforce'] {
  const authModeEnvValue = resolveEnv('SF_AUTH_MODE', {
    fallbackNames: ['SALESFORCE_AUTH_MODE'],
    defaultValue: 'disabled',
  });
  const authModeExplicitlySet = Boolean(
    process.env.SF_AUTH_MODE ?? process.env.SALESFORCE_AUTH_MODE
  );
  const clientId = resolveEnv('SF_CLIENT_ID', { fallbackNames: ['SALESFORCE_CLIENT_ID'] });
  const clientSecret = resolveEnv('SF_CLIENT_SECRET', {
    fallbackNames: ['SALESFORCE_CLIENT_SECRET'],
  });

  let authMode = authModeEnvValue.toLowerCase() as SalesforceAuthMode;
  if (!authModeExplicitlySet && authMode === 'disabled' && clientId && clientSecret) {
    authMode = 'client-credentials';
  }

  const salesforceSchema = z.object({
    authMode: z.enum(['disabled', 'client-credentials'] as const),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    loginUrl: z.string().url(),
  });

  const salesforce = salesforceSchema.parse({
    authMode,
    clientId,
    clientSecret,
    loginUrl: resolveEnv('SF_LOGIN_URL', {
      fallbackNames: ['SALESFORCE_LOGIN_URL'],
      defaultValue: DEFAULT_SALESFORCE_LOGIN_URL,
    }),
  });

  if (salesforce.authMode === 'client-credentials') {
    if (!salesforce.clientId) {
      ctx.missing.push('SF_CLIENT_ID (or SALESFORCE_CLIENT_ID)');
    }
    if (!salesforce.clientSecret) {
      ctx.missing.push('SF_CLIENT_SECRET (or SALESFORCE_CLIENT_SECRET)');
    }
  }

  return salesforce;
}

function loadQuickBooks(ctx: LoadContext): EnvConfig['quickBooks'] {
  const environment = normalizeQboEnvironment(
    resolveEnv('QBO_ENV', { fallbackNames: ['QBO_ENVIRONMENT'], defaultValue: 'sandbox' })
  );
  if (!environment) {
    ctx.errors.push('QBO_ENV (or QBO_ENVIRONMENT) must be one of: "sandbox", "production".');
  }

  const quickBooksSchema = z.object({
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

  const parsed = quickBooksSchema.parse({
    realmId: resolveEnv('QBO_REALM_ID', { fallbackNames: ['QBO_COMPANY_ID'] }),
    clientId: resolveEnv('QBO_CLIENT_ID'),
    clientSecret: resolveEnv('QBO_CLIENT_SECRET'),
    redirectUri: resolveEnv('QBO_REDIRECT_URI'),
    refreshToken: resolveEnv('QBO_REFRESH_TOKEN'),
    accounts: {
      stripeClearing: resolveEnv('QBO_ACCOUNT_STRIPE_CLEARING', {
        fallbackNames: ['ACCOUNTING_STRIPE_CLEARING_ACCOUNT'],
        defaultValue: 'Stripe Clearing',
      }),
      operatingBank: resolveEnv('QBO_ACCOUNT_OPERATING_BANK', {
        fallbackNames: ['ACCOUNTING_OPERATING_BANK_ACCOUNT'],
        defaultValue: 'Operating Bank',
      }),
      revenue: resolveEnv('QBO_ACCOUNT_REVENUE', {
        fallbackNames: ['ACCOUNTING_REVENUE_ACCOUNT'],
        defaultValue: 'Revenue',
      }),
      fees: resolveEnv('QBO_ACCOUNT_FEES', {
        fallbackNames: ['ACCOUNTING_STRIPE_FEE_ACCOUNT'],
        defaultValue: 'Stripe Fees',
      }),
      refunds: resolveEnv('QBO_ACCOUNT_REFUNDS', {
        fallbackNames: ['ACCOUNTING_REFUNDS_ACCOUNT'],
        defaultValue: 'Refunds',
      }),
      disputeLosses: resolveEnv('QBO_ACCOUNT_DISPUTES', {
        fallbackNames: ['ACCOUNTING_DISPUTE_LOSS_ACCOUNT'],
        defaultValue: 'Dispute Losses',
      }),
    },
  });

  return { environment: environment ?? 'sandbox', ...parsed };
}

function loadAccounting(ctx: LoadContext): EnvConfig['accounting'] {
  const postingStrategySchema = z.enum(['je-transfer', 'sales-receipt'] as const);
  const postingStrategy = postingStrategySchema.safeParse(
    resolveEnv('ACCOUNTING_POSTING_STRATEGY', { defaultValue: 'je-transfer' }).toLowerCase()
  );
  if (!postingStrategy.success) {
    ctx.errors.push('ACCOUNTING_POSTING_STRATEGY must be one of: "je-transfer", "sales-receipt".');
  }

  const syncEnabled = parseBoolean(
    'ACCOUNTING_SYNC_ENABLED',
    resolveEnv('ACCOUNTING_SYNC_ENABLED', { defaultValue: 'false' }),
    false
  );

  const defaultSalesItem = resolveEnv('QBO_DEFAULT_SALES_ITEM', {
    fallbackNames: ['ACCOUNTING_DEFAULT_SALES_ITEM'],
    defaultValue: 'Stripe Transaction',
  });

  const autoCreate = parseBoolean(
    'ACCOUNTING_AUTOCREATE_ACCOUNTS',
    resolveEnv('ACCOUNTING_AUTOCREATE_ACCOUNTS', { defaultValue: 'false' }),
    false
  );

  const types = {
    stripeClearing: {
      accountType: resolveEnv('ACCOUNTING_STRIPE_CLEARING_ACCOUNT_TYPE', { defaultValue: 'Bank' }),
      accountSubType: resolveEnv('ACCOUNTING_STRIPE_CLEARING_ACCOUNT_SUBTYPE', {
        defaultValue: 'CashOnHand',
      }),
    },
    operatingBank: {
      accountType: resolveEnv('ACCOUNTING_OPERATING_BANK_ACCOUNT_TYPE', { defaultValue: 'Bank' }),
      accountSubType: resolveEnv('ACCOUNTING_OPERATING_BANK_ACCOUNT_SUBTYPE', {
        defaultValue: 'Checking',
      }),
    },
    revenue: {
      accountType: resolveEnv('ACCOUNTING_REVENUE_ACCOUNT_TYPE', { defaultValue: 'Income' }),
      accountSubType: resolveEnv('ACCOUNTING_REVENUE_ACCOUNT_SUBTYPE', {
        defaultValue: 'ServiceFeeIncome',
      }),
    },
    fees: {
      accountType: resolveEnv('ACCOUNTING_FEES_ACCOUNT_TYPE', { defaultValue: 'Expense' }),
      accountSubType: resolveEnv('ACCOUNTING_FEES_ACCOUNT_SUBTYPE', {
        defaultValue: 'OtherMiscellaneousExpense',
      }),
    },
    refunds: {
      accountType: resolveEnv('ACCOUNTING_REFUNDS_ACCOUNT_TYPE', { defaultValue: 'Expense' }),
      accountSubType: resolveEnv('ACCOUNTING_REFUNDS_ACCOUNT_SUBTYPE', {
        defaultValue: 'OtherMiscellaneousExpense',
      }),
    },
    disputeLosses: {
      accountType: resolveEnv('ACCOUNTING_DISPUTE_LOSSES_ACCOUNT_TYPE', {
        defaultValue: 'Expense',
      }),
      accountSubType: resolveEnv('ACCOUNTING_DISPUTE_LOSSES_ACCOUNT_SUBTYPE', {
        defaultValue: 'OtherMiscellaneousExpense',
      }),
    },
  };

  return {
    postingStrategy: (postingStrategy.success
      ? postingStrategy.data
      : 'je-transfer') as AccountingPostingStrategy,
    syncEnabled,
    defaultSalesItem,
    accounts: {
      autoCreate,
      types,
    },
  };
}

function loadEnv(): EnvConfig {
  const ctx: LoadContext = { missing: [], errors: [] };

  const stripe = loadStripe(ctx);
  const salesforce = loadSalesforce(ctx);
  const quickBooks = loadQuickBooks(ctx);
  const accounting = loadAccounting(ctx);
  const testMode = parseBoolean(
    'TEST_MODE',
    resolveEnv('TEST_MODE', { defaultValue: 'false' }),
    false
  );

  // QBO credentials are required only when accounting sync is enabled.
  if (accounting.syncEnabled) {
    if (!quickBooks.realmId) {
      ctx.missing.push('QBO_REALM_ID');
    }
    if (!quickBooks.clientId) {
      ctx.missing.push('QBO_CLIENT_ID');
    }
    if (!quickBooks.clientSecret) {
      ctx.missing.push('QBO_CLIENT_SECRET');
    }
  }

  if (ctx.missing.length > 0) {
    throw new EnvConfigError(`Missing required environment variables: ${ctx.missing.join(', ')}`);
  }

  if (ctx.errors.length > 0) {
    throw new EnvConfigError(ctx.errors.join(' '));
  }

  return {
    stripe,
    testMode,
    salesforce,
    quickBooks,
    accounting,
  };
}

export const env = loadEnv();

export default env;
