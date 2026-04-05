import Stripe from 'stripe';
import type { Connection } from 'jsforce/lib/connection';

import { buildSalesforceConfig, SalesforceService } from './salesforceService';
import { buildTestArtifactMarker } from '../lib/testArtifactTagging';
import {
  deleteQuickBooksDocument,
  findDocumentsByPrivateNoteTag,
  type TaggedQuickBooksDocument,
} from './qboSvc';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';
const TRANSACTION_OBJECT = 'Transaction__c';

export type CleanupSystem = 'stripe' | 'salesforce' | 'qbo';

export interface TestArtifactCleanupRequest {
  tag: string;
  dryRun?: boolean;
  liveMode?: boolean;
  systems?: CleanupSystem[];
  deleteSalesforceContacts?: boolean;
  maxStripeCustomers?: number;
  maxQboDocuments?: number;
}

type CleanupOperationStatus = 'deleted' | 'expired' | 'canceled' | 'dry-run' | 'skipped' | 'error';

interface CleanupOperationResult {
  id: string;
  type: string;
  action: string;
  status: CleanupOperationStatus;
  message?: string;
}

export interface TestArtifactCleanupSystemSummary {
  system: CleanupSystem;
  dryRun: boolean;
  counts: {
    found: number;
    changed: number;
    skipped: number;
    errors: number;
  };
  records: CleanupOperationResult[];
}

export interface TestArtifactCleanupResult {
  tag: string;
  marker: string;
  dryRun: boolean;
  liveMode: boolean;
  systems: CleanupSystem[];
  stripeCustomerIds: string[];
  results: TestArtifactCleanupSystemSummary[];
}

interface TestArtifactCleanupDependencies {
  createStripeClient: (liveMode: boolean) => Stripe;
  getSalesforceConnection: () => Promise<Connection>;
  findTaggedQuickBooksDocuments: (
    tag: string,
    maxResultsPerEntity: number
  ) => Promise<TaggedQuickBooksDocument[]>;
  deleteQuickBooksDocument: (document: TaggedQuickBooksDocument) => Promise<void>;
}

type StripeCustomerRecord = Pick<Stripe.Customer, 'id' | 'email'>;
type StripeSubscriptionRecord = Pick<Stripe.Subscription, 'id' | 'customer' | 'status'>;
type StripeSessionRecord = Pick<Stripe.Checkout.Session, 'id' | 'status' | 'customer'>;

const DEFAULT_SYSTEMS: CleanupSystem[] = ['stripe', 'salesforce', 'qbo'];

const normalizeSystems = (systems: CleanupSystem[] | undefined): CleanupSystem[] => {
  const requested = Array.isArray(systems) && systems.length > 0 ? systems : DEFAULT_SYSTEMS;
  return Array.from(new Set(requested));
};

const normalizePositiveInt = (value: number | undefined, fallback: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.trunc(value as number)));
};

const escapeStripeSearchValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const escapeSoqlLiteral = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const chooseStripeSecret = (liveMode: boolean): string => {
  const secret = liveMode
    ? process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET
    : process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET;

  const trimmed = (secret || '').trim();
  if (!trimmed) {
    throw new Error(`Missing Stripe ${liveMode ? 'live' : 'test'} secret key.`);
  }

  return trimmed;
};

const buildDefaultDependencies = (): TestArtifactCleanupDependencies => ({
  createStripeClient: (liveMode) =>
    new Stripe(chooseStripeSecret(liveMode), { apiVersion: STRIPE_API_VERSION }),
  getSalesforceConnection: async () => {
    const service = new SalesforceService(buildSalesforceConfig());
    return service.authenticate();
  },
  findTaggedQuickBooksDocuments: findDocumentsByPrivateNoteTag,
  deleteQuickBooksDocument,
});

const createSummary = (
  system: CleanupSystem,
  dryRun: boolean
): TestArtifactCleanupSystemSummary => ({
  system,
  dryRun,
  counts: {
    found: 0,
    changed: 0,
    skipped: 0,
    errors: 0,
  },
  records: [],
});

const pushResult = (
  summary: TestArtifactCleanupSystemSummary,
  result: CleanupOperationResult
): void => {
  summary.records.push(result);
  summary.counts.found += 1;

  if (result.status === 'error') {
    summary.counts.errors += 1;
    return;
  }

  if (result.status === 'skipped') {
    summary.counts.skipped += 1;
    return;
  }

  summary.counts.changed += 1;
};

const listStripeCustomersByTag = async (
  stripe: Stripe,
  tag: string,
  limit: number
): Promise<StripeCustomerRecord[]> => {
  const customers: StripeCustomerRecord[] = [];
  let page: string | undefined;

  while (customers.length < limit) {
    const response = await stripe.customers.search({
      query: `metadata['source_test_tag']:'${escapeStripeSearchValue(tag)}'`,
      limit: Math.min(100, limit - customers.length),
      ...(page ? { page } : {}),
    });

    customers.push(
      ...response.data.filter((customer): customer is Stripe.Customer => !('deleted' in customer))
    );

    if (!response.has_more || !response.next_page) {
      break;
    }

    page = response.next_page;
  }

  return customers.map((customer) => ({ id: customer.id, email: customer.email }));
};

const listStripeSubscriptionsForCustomer = async (
  stripe: Stripe,
  customerId: string
): Promise<StripeSubscriptionRecord[]> => {
  const subscriptions: StripeSubscriptionRecord[] = [];

  let startingAfter: string | undefined;
  while (subscriptions.length < 1000) {
    const response = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    subscriptions.push(
      ...response.data.map((subscription) => ({
        id: subscription.id,
        customer: subscription.customer,
        status: subscription.status,
      }))
    );

    if (!response.has_more || response.data.length === 0) {
      break;
    }

    startingAfter = response.data[response.data.length - 1]?.id;
  }

  return subscriptions;
};

const listStripeSessionsForCustomer = async (
  stripe: Stripe,
  customerId: string
): Promise<StripeSessionRecord[]> => {
  const sessions: StripeSessionRecord[] = [];

  let startingAfter: string | undefined;
  while (sessions.length < 1000) {
    const response = await stripe.checkout.sessions.list({
      customer: customerId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    sessions.push(
      ...response.data.map((session) => ({
        id: session.id,
        status: session.status,
        customer: session.customer,
      }))
    );

    if (!response.has_more || response.data.length === 0) {
      break;
    }

    startingAfter = response.data[response.data.length - 1]?.id;
  }

  return sessions;
};

const listTaggedStripeSessionsUsingCheckoutSearch = async (
  stripe: Stripe,
  tag: string,
  limit: number
): Promise<StripeSessionRecord[]> => {
  const sessions: StripeSessionRecord[] = [];
  let page: string | undefined;

  while (sessions.length < limit) {
    const response: any = await (stripe.checkout.sessions as any).search({
      query: `metadata['source_test_tag']:'${escapeStripeSearchValue(tag)}'`,
      limit: Math.min(100, limit - sessions.length),
      ...(page ? { page } : {}),
    });

    sessions.push(
      ...((response.data as any[]).map((session) => ({
        id: session.id,
        status: session.status,
        customer: session.customer,
      })) as StripeSessionRecord[])
    );

    if (!response.has_more || !response.next_page) {
      break;
    }

    page = response.next_page;
  }

  return sessions;
};

const listTaggedStripeSessionsUsingGlobalSearch = async (
  stripe: Stripe,
  tag: string,
  limit: number
): Promise<StripeSessionRecord[]> => {
  const sessions: StripeSessionRecord[] = [];
  let page: string | undefined;
  const globalSearch: any = (stripe as any).search;

  while (sessions.length < limit) {
    const response: any = await globalSearch.search({
      query: `metadata['source_test_tag']:'${escapeStripeSearchValue(tag)}'`,
      type: 'checkout.session',
      limit: Math.min(100, limit - sessions.length),
      ...(page ? { page } : {}),
    });

    sessions.push(
      ...((response.data as any[]).map((session) => ({
        id: session.id,
        status: session.status,
        customer: session.customer,
      })) as StripeSessionRecord[])
    );

    if (!response.has_more || !response.next_page) {
      break;
    }

    page = response.next_page;
  }

  return sessions;
};

const listTaggedStripeSessions = async (
  stripe: Stripe,
  tag: string,
  limit: number
): Promise<StripeSessionRecord[]> => {
  if (typeof (stripe.checkout.sessions as any).search === 'function') {
    return listTaggedStripeSessionsUsingCheckoutSearch(stripe, tag, limit);
  }

  const globalSearch = (stripe as any).search;
  if (globalSearch && typeof globalSearch.search === 'function') {
    return listTaggedStripeSessionsUsingGlobalSearch(stripe, tag, limit);
  }

  return [];
};

const cleanupStripeArtifacts = async (
  stripe: Stripe,
  request: Required<Pick<TestArtifactCleanupRequest, 'tag' | 'dryRun' | 'maxStripeCustomers'>>
): Promise<{ summary: TestArtifactCleanupSystemSummary; stripeCustomerIds: string[] }> => {
  const summary = createSummary('stripe', request.dryRun);
  const customers = await listStripeCustomersByTag(stripe, request.tag, request.maxStripeCustomers);
  const taggedSessions = await listTaggedStripeSessions(
    stripe,
    request.tag,
    request.maxStripeCustomers * 5
  );

  const stripeCustomerIds = new Set(customers.map((customer) => customer.id));
  const sessionsById = new Map<string, StripeSessionRecord>();

  for (const session of taggedSessions) {
    if (typeof session.customer === 'string' && session.customer.trim().length > 0) {
      stripeCustomerIds.add(session.customer);
    }
    sessionsById.set(session.id, session);
  }

  for (const customerId of Array.from(stripeCustomerIds)) {
    const sessions = await listStripeSessionsForCustomer(stripe, customerId);
    sessions.forEach((session) => sessionsById.set(session.id, session));
  }

  for (const session of sessionsById.values()) {
    if (session.status !== 'open') {
      continue;
    }

    if (request.dryRun) {
      pushResult(summary, {
        id: session.id,
        type: 'checkout-session',
        action: 'expire',
        status: 'dry-run',
        message: `Would expire open checkout session ${session.id}.`,
      });
    } else {
      await stripe.checkout.sessions.expire(session.id);
      pushResult(summary, {
        id: session.id,
        type: 'checkout-session',
        action: 'expire',
        status: 'expired',
      });
    }
  }

  for (const customerId of Array.from(stripeCustomerIds)) {
    const subscriptions = await listStripeSubscriptionsForCustomer(stripe, customerId);
    for (const subscription of subscriptions) {
      if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
        pushResult(summary, {
          id: subscription.id,
          type: 'subscription',
          action: 'cancel',
          status: 'skipped',
          message: `Subscription already ${subscription.status}.`,
        });
        continue;
      }

      if (request.dryRun) {
        pushResult(summary, {
          id: subscription.id,
          type: 'subscription',
          action: 'cancel',
          status: 'dry-run',
        });
      } else {
        await stripe.subscriptions.cancel(subscription.id);
        pushResult(summary, {
          id: subscription.id,
          type: 'subscription',
          action: 'cancel',
          status: 'canceled',
        });
      }
    }

    if (request.dryRun) {
      pushResult(summary, {
        id: customerId,
        type: 'customer',
        action: 'delete',
        status: 'dry-run',
        message: `Would delete Stripe customer ${customerId}.`,
      });
      continue;
    }

    await stripe.customers.del(customerId);
    pushResult(summary, {
      id: customerId,
      type: 'customer',
      action: 'delete',
      status: 'deleted',
      message: undefined,
    });
  }

  return { summary, stripeCustomerIds: Array.from(stripeCustomerIds) };
};

const querySalesforceIds = async (connection: Connection, soql: string): Promise<string[]> => {
  const result = await connection.query<{ Id?: string }>(soql);
  const records = Array.isArray(result.records) ? result.records : [];
  return records
    .map((record) => (typeof record.Id === 'string' ? record.Id.trim() : ''))
    .filter((id) => id.length > 0);
};

const buildStripeCustomerConditions = (fieldName: string, stripeCustomerIds: string[]): string[] =>
  stripeCustomerIds.map(
    (stripeCustomerId) => `${fieldName} LIKE '%${escapeSoqlLiteral(stripeCustomerId)}%'`
  );

const cleanupSalesforceArtifacts = async (
  connection: Connection,
  request: Required<
    Pick<TestArtifactCleanupRequest, 'tag' | 'dryRun' | 'deleteSalesforceContacts'>
  >,
  stripeCustomerIds: string[]
): Promise<TestArtifactCleanupSystemSummary> => {
  const summary = createSummary('salesforce', request.dryRun);
  const transactionConditions: string[] = [];

  if (stripeCustomerIds.length > 0) {
    transactionConditions.push(
      ...buildStripeCustomerConditions('Stripe_Customer_Id__c', stripeCustomerIds)
    );
  } else {
    // Memo__c is often a long-text area and cannot be filtered with LIKE in SOQL.
    // Cleanup by Salesforce transaction is only supported when the transaction has
    // an associated Stripe customer ID to search for.
    return summary;
  }

  const transactionIds = await querySalesforceIds(
    connection,
    `SELECT Id FROM ${TRANSACTION_OBJECT} WHERE ${transactionConditions.join(' OR ')}`
  );

  if (request.dryRun) {
    transactionIds.forEach((id) =>
      pushResult(summary, {
        id,
        type: TRANSACTION_OBJECT,
        action: 'delete',
        status: 'dry-run',
      })
    );
  } else if (transactionIds.length > 0) {
    const result = await connection.sobject(TRANSACTION_OBJECT).destroy(transactionIds);
    const results = Array.isArray(result) ? result : [result];
    results.forEach((entry, index) => {
      if (entry.success) {
        pushResult(summary, {
          id: entry.id || transactionIds[index],
          type: TRANSACTION_OBJECT,
          action: 'delete',
          status: 'deleted',
        });
        return;
      }

      pushResult(summary, {
        id: transactionIds[index],
        type: TRANSACTION_OBJECT,
        action: 'delete',
        status: 'error',
        message: Array.isArray(entry.errors)
          ? entry.errors.map((error) => error.message).join('; ')
          : 'Delete failed.',
      });
    });
  }

  if (!request.deleteSalesforceContacts || stripeCustomerIds.length === 0) {
    return summary;
  }

  const contactIds = await querySalesforceIds(
    connection,
    `SELECT Id FROM Contact WHERE ${buildStripeCustomerConditions('Stripe_Customer_ID__c', stripeCustomerIds).join(' OR ')}`
  );

  if (request.dryRun) {
    contactIds.forEach((id) =>
      pushResult(summary, {
        id,
        type: 'Contact',
        action: 'delete',
        status: 'dry-run',
      })
    );
    return summary;
  }

  if (contactIds.length === 0) {
    return summary;
  }

  const result = await connection.sobject('Contact').destroy(contactIds);
  const results = Array.isArray(result) ? result : [result];
  results.forEach((entry, index) => {
    if (entry.success) {
      pushResult(summary, {
        id: entry.id || contactIds[index],
        type: 'Contact',
        action: 'delete',
        status: 'deleted',
      });
      return;
    }

    pushResult(summary, {
      id: contactIds[index],
      type: 'Contact',
      action: 'delete',
      status: 'error',
      message: Array.isArray(entry.errors)
        ? entry.errors.map((error) => error.message).join('; ')
        : 'Delete failed.',
    });
  });

  return summary;
};

const cleanupQuickBooksArtifacts = async (
  request: Required<Pick<TestArtifactCleanupRequest, 'tag' | 'dryRun' | 'maxQboDocuments'>>,
  dependencies: Pick<
    TestArtifactCleanupDependencies,
    'findTaggedQuickBooksDocuments' | 'deleteQuickBooksDocument'
  >
): Promise<TestArtifactCleanupSystemSummary> => {
  const summary = createSummary('qbo', request.dryRun);
  const documents = await dependencies.findTaggedQuickBooksDocuments(
    request.tag,
    request.maxQboDocuments
  );

  for (const document of documents) {
    if (request.dryRun) {
      pushResult(summary, {
        id: document.id,
        type: document.type,
        action: 'delete',
        status: 'dry-run',
        message: document.docNumber ?? undefined,
      });
      continue;
    }

    try {
      await dependencies.deleteQuickBooksDocument(document);
      pushResult(summary, {
        id: document.id,
        type: document.type,
        action: 'delete',
        status: 'deleted',
        message: document.docNumber ?? undefined,
      });
    } catch (error) {
      pushResult(summary, {
        id: document.id,
        type: document.type,
        action: 'delete',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
};

export const executeTestArtifactCleanup = async (
  request: TestArtifactCleanupRequest,
  dependencies: TestArtifactCleanupDependencies = buildDefaultDependencies()
): Promise<TestArtifactCleanupResult> => {
  const tag = request.tag.trim();
  if (!tag) {
    throw new Error('Cleanup tag is required.');
  }

  const dryRun = request.dryRun ?? true;
  const liveMode = request.liveMode ?? false;
  const systems = normalizeSystems(request.systems);
  const maxStripeCustomers = normalizePositiveInt(request.maxStripeCustomers, 100, 500);
  const maxQboDocuments = normalizePositiveInt(request.maxQboDocuments, 100, 500);
  const deleteSalesforceContacts = request.deleteSalesforceContacts ?? true;
  const results: TestArtifactCleanupSystemSummary[] = [];
  let stripeCustomerIds: string[] = [];

  if (systems.includes('stripe')) {
    const stripe = dependencies.createStripeClient(liveMode);
    const stripeResult = await cleanupStripeArtifacts(stripe, {
      tag,
      dryRun,
      maxStripeCustomers,
    });
    stripeCustomerIds = stripeResult.stripeCustomerIds;
    results.push(stripeResult.summary);
  }

  if (systems.includes('salesforce')) {
    const connection = await dependencies.getSalesforceConnection();
    const salesforceSummary = await cleanupSalesforceArtifacts(
      connection,
      {
        tag,
        dryRun,
        deleteSalesforceContacts,
      },
      stripeCustomerIds
    );
    results.push(salesforceSummary);
  }

  if (systems.includes('qbo')) {
    const qboSummary = await cleanupQuickBooksArtifacts(
      {
        tag,
        dryRun,
        maxQboDocuments,
      },
      dependencies
    );
    results.push(qboSummary);
  }

  return {
    tag,
    marker: buildTestArtifactMarker(tag),
    dryRun,
    liveMode,
    systems,
    stripeCustomerIds,
    results,
  };
};
