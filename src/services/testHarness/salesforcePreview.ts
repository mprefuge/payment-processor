import { mapStripeToTransaction, type TransactionUpsertDTO } from '../../domain/transactions';
import {
  appendTestArtifactMarker,
  buildSyntheticCustomerIdTagSegment,
  buildTestArtifactMarker,
} from '../../lib/testArtifactTagging';
import {
  buildNewContactRecord,
  normalizeCustomerName,
  sanitizeTransactionRecord,
  NULL_MEANS_UNKNOWN_FIELDS,
  TRANSACTION_FIELD_API_NAMES,
} from '../salesforceSvc';
import type { ResolvedDonation, SyntheticStripeContext } from './syntheticDonation';

/**
 * Renders the Salesforce writes a donation would produce, without opening a connection.
 *
 * The Transaction__c field map is produced by `mapStripeToTransaction` — the same function
 * the `payment_intent.succeeded` webhook calls — and then by `sanitizeTransactionRecord`,
 * the same function `upsertTransaction` applies immediately before DML. That is what makes
 * this a preview of the real write rather than a second implementation of it: the
 * null-means-unknown skips reported below are the actual skips, computed by the actual
 * rule, not a restatement of it.
 */

/** Fields an operator most often comes to this endpoint to check. */
export const HIGHLIGHTED_TRANSACTION_FIELDS = [
  'cover_fees_amount__c',
  'amount_fee__c',
  'frequency__c',
  'payment_method__c',
  'stripe_livemode__c',
] as const;

export interface SkippedField {
  dtoField: string;
  apiName: string;
  reason: string;
}

export interface SalesforcePreviewResult extends Record<string, unknown> {
  writesNothing: string;
  contact: Record<string, unknown>;
  transaction: Record<string, unknown>;
  /**
   * The DTO in the shape `upsertTransactionByExternalId` expects, before
   * `sanitizeTransactionRecord` maps it to API names. Carried so a non-dry-run call can
   * write exactly what the preview showed rather than rebuilding it.
   */
  transactionDto: TransactionUpsertDTO;
  highlights: Record<string, unknown>;
  skippedByNullMeansUnknown: SkippedField[];
  warnings: string[];
}

const apiNameFor = (dtoField: string): string =>
  TRANSACTION_FIELD_API_NAMES[dtoField as keyof TransactionUpsertDTO] ?? dtoField;

export const buildSalesforcePreview = (input: {
  donation: ResolvedDonation;
  stripe: SyntheticStripeContext;
  cleanupTag: string;
  baseWarnings?: string[];
}): SalesforcePreviewResult => {
  const { donation, stripe, cleanupTag } = input;
  const warnings = [...(input.baseWarnings ?? [])];

  const dto = mapStripeToTransaction({
    paymentIntent: stripe.paymentIntent,
    charge: stripe.charge,
    balanceTransaction: stripe.balanceTransaction,
    stripeCustomer: stripe.customer,
  });

  // The marker is what POST /api/ops/test-artifact-cleanup keys a QuickBooks document on.
  // Salesforce cleanup keys on Stripe_Customer_Id__c instead — Memo__c is a Long Text Area
  // and cannot be filtered in SOQL — so the marker in the memo is for a human reading the
  // record, while the queryable copy of the tag rides inside the customer id.
  dto.memo__c = appendTestArtifactMarker(dto.memo__c ?? null, cleanupTag) ?? null;

  const sanitized = sanitizeTransactionRecord(dto);

  const skippedByNullMeansUnknown: SkippedField[] = [];
  for (const [dtoField, value] of Object.entries(dto)) {
    if (value === null && NULL_MEANS_UNKNOWN_FIELDS.has(dtoField)) {
      skippedByNullMeansUnknown.push({
        dtoField,
        apiName: apiNameFor(dtoField),
        reason:
          'null here means "this writer could not determine it", never "clear the value". ' +
          'sanitizeTransactionRecord drops it so the upsert cannot wipe donor intent that ' +
          'the checkout path already wrote.',
      });
    }
  }

  if (donation.processorFeeCents === null) {
    warnings.push(
      'Amount_Fee__c and Amount_Net__c are absent because there is no balance transaction. ' +
        'They are unknown, not zero — the webhook would leave them unset until Stripe settles.'
    );
  }

  const { firstName, lastName } = normalizeCustomerName({
    stripe_customer_id__c: stripe.ids.customerId,
    Name: donation.donor.fullName,
    Email: donation.donor.email,
    FirstName: donation.donor.firstName,
    LastName: donation.donor.lastName,
  });

  const contactRecord = buildNewContactRecord({
    stripeCustomerId: stripe.ids.customerId,
    name: donation.donor.fullName,
    email: donation.donor.email,
    firstName,
    lastName,
  });

  const highlights: Record<string, unknown> = {};
  for (const field of HIGHLIGHTED_TRANSACTION_FIELDS) {
    const apiName = apiNameFor(field);
    highlights[apiName] = Object.prototype.hasOwnProperty.call(sanitized, apiName)
      ? sanitized[apiName]
      : null;
  }

  return {
    writesNothing:
      'Nothing was written. No Salesforce connection was opened and no SOQL was issued.',
    contact: {
      object: 'Contact',
      matchStrategy:
        'The live path first queries Contact by Stripe_Customer_Id__c, then Email, then ' +
        'FirstName+LastName, and updates the best match instead of creating. Running the ' +
        'query is a read against the org, so this preview always renders the CREATE shape.',
      wouldCreate: contactRecord,
      recordTypeId:
        'Resolved at write time from RecordType where SobjectType=Contact; a query, so absent here.',
    },
    transactionDto: dto,
    transaction: {
      object: 'Transaction__c',
      externalIdField: 'Stripe_Payment_Intent_Id__c',
      recordType: 'Stripe Transaction',
      fields: sanitized,
    },
    highlights,
    skippedByNullMeansUnknown,
    cleanupMarker: buildTestArtifactMarker(cleanupTag),
    cleanupHandle: {
      queryableField: 'Stripe_Customer_Id__c',
      note:
        'POST /api/ops/test-artifact-cleanup finds BOTH the Contact and the Transaction__c ' +
        'through Stripe_Customer_Id__c, the one field carried by both objects that SOQL can ' +
        'filter (Memo__c is a Long Text Area and is not filterable, so the marker there is ' +
        'only for a human reading the record). The synthetic customer id below embeds the ' +
        'cleanup tag, so the rows are reachable from the tag alone even though no such ' +
        'customer has ever existed in Stripe.',
      stripeCustomerId: stripe.ids.customerId,
      soqlLikeSegment: buildSyntheticCustomerIdTagSegment(cleanupTag),
      contactField: 'Stripe_Customer_Id__c',
      transactionField: 'Stripe_Customer_Id__c',
    },
    warnings,
  };
};
