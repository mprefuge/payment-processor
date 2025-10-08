import { SalesforceClient } from "../salesforce/salesforce_client";
import { NormalizedTransaction } from "./normalize";
import { ServiceContext } from "../shared/types";

type SalesforceSummary = {
  action: "created" | "updated" | "noop";
  id: string | null;
};

type ContactLike = {
  customerId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
};

type SalesforceRecordResult = {
  id: string;
  action: "created" | "updated";
};

const normalizeEmail = (value: string | undefined) =>
  value ? value.trim().toLowerCase() : undefined;

const defaultSummary: SalesforceSummary = { action: "noop", id: null };

const findContactSource = (transaction: NormalizedTransaction): ContactLike | null => {
  const payment = transaction.payments?.[0];
  if (payment) {
    const metadata = payment.metadata ?? {};
    const email =
      normalizeEmail(metadata.customer_email ?? metadata.email ?? undefined) ??
      undefined;
    const fullName = metadata.customer_name ?? metadata.name ?? payment.description;

    let firstName: string | undefined;
    let lastName: string | undefined;
    if (fullName && fullName.includes(" ")) {
      const parts = fullName.split(" ");
      firstName = parts[0];
      lastName = parts.slice(1).join(" ");
    } else if (fullName) {
      lastName = fullName;
    }

    return {
      customerId: payment.customerId,
      email,
      firstName,
      lastName,
    };
  }

  const refund = transaction.refunds?.[0];
  if (refund) {
    const metadata = refund.metadata ?? {};
    const email = normalizeEmail(metadata.customer_email ?? metadata.email ?? undefined);
    return {
      email,
      lastName: refund.reason ?? refund.refundId,
    };
  }

  const dispute = transaction.disputes?.[0];
  if (dispute) {
    const metadata = dispute.metadata ?? {};
    const email = normalizeEmail(metadata.customer_email ?? metadata.email ?? undefined);
    return {
      email,
      lastName: dispute.reason ?? dispute.disputeId,
    };
  }

  return null;
};

const contactPayloadFromSource = (source: ContactLike | null) => {
  if (!source) {
    return null;
  }

  if (!source.customerId && !source.email) {
    return null;
  }

  const payload: Record<string, unknown> = {};

  if (source.email) {
    payload.Email = source.email;
  }

  if (source.firstName) {
    payload.FirstName = source.firstName;
  }

  if (source.lastName) {
    payload.LastName = source.lastName;
  }

  if (!payload.LastName) {
    payload.LastName = "Stripe Customer";
  }

  if (source.customerId) {
    payload.stripe_customer_id__c = source.customerId;
  }

  return payload;
};

const upsertContact = async (
  client: SalesforceClient,
  transaction: NormalizedTransaction,
): Promise<SalesforceRecordResult | null> => {
  const source = contactPayloadFromSource(findContactSource(transaction));
  if (!source) {
    return null;
  }

  const customerId = (source as { stripe_customer_id__c?: string }).stripe_customer_id__c;
  if (customerId) {
    return client.upsert("Contact", "stripe_customer_id__c", customerId, source);
  }

  if (source.Email) {
    return client.upsert("Contact", "Email", source.Email as string, source);
  }

  return null;
};

const centsToDollars = (amount: number | undefined) => {
  if (typeof amount !== "number") {
    return undefined;
  }

  return amount / 100;
};

const isoDate = (iso: string | undefined) => {
  if (!iso) {
    return undefined;
  }
  return iso.split("T")[0];
};

const syncPaymentNpsp = async (
  client: SalesforceClient,
  payment: NonNullable<NormalizedTransaction["payments"]>[number],
  contactId: string | null,
) => {
  const opportunity = await client.upsert(
    "Opportunity",
    "Stripe_Charge_Id__c",
    payment.chargeId,
    {
      Name: payment.description ?? `Stripe Payment ${payment.chargeId}`,
      StageName: "Closed Won",
      CloseDate: isoDate(payment.created),
      Amount: centsToDollars(payment.amount.amount),
      Stripe_Charge_Id__c: payment.chargeId,
      Stripe_Invoice_Id__c: payment.invoiceId,
      Stripe_Customer_Id__c: payment.customerId,
      CurrencyIsoCode: payment.amount.currency?.toUpperCase(),
      Primary_Contact__c: contactId ?? undefined,
    },
  );

  const paymentRecord = await client.upsert(
    "npsp__Payment__c",
    "Stripe_Charge_Id__c",
    payment.chargeId,
    {
      Name: payment.description ?? `Stripe Payment ${payment.chargeId}`,
      Stripe_Charge_Id__c: payment.chargeId,
      npsp__Payment_Date__c: isoDate(payment.created),
      npsp__Amount__c: centsToDollars(payment.amount.amount),
      npsp__Paid__c: payment.status === "succeeded",
      npsp__Opportunity__c: opportunity.id,
      Contact__c: contactId ?? undefined,
      CurrencyIsoCode: payment.amount.currency?.toUpperCase(),
    },
  );

  return paymentRecord;
};

const syncPayment = async (
  client: SalesforceClient,
  payment: NonNullable<NormalizedTransaction["payments"]>[number],
  contactId: string | null,
  useNpsp: boolean,
) => {
  if (useNpsp) {
    return syncPaymentNpsp(client, payment, contactId);
  }

  return client.upsert("Payment__c", "Stripe_Charge_Id__c", payment.chargeId, {
    Name: payment.description ?? `Payment ${payment.chargeId}`,
    Stripe_Charge_Id__c: payment.chargeId,
    Stripe_Invoice_Id__c: payment.invoiceId,
    Stripe_Customer_Id__c: payment.customerId,
    Amount__c: payment.amount.amount,
    Currency__c: payment.amount.currency,
    Status__c: payment.status,
    Contact__c: contactId ?? undefined,
  });
};

const syncRefund = (
  client: SalesforceClient,
  refund: NonNullable<NormalizedTransaction["refunds"]>[number],
) =>
  client.upsert("Refund__c", "Stripe_Refund_Id__c", refund.refundId, {
    Name: refund.refundId,
    Stripe_Refund_Id__c: refund.refundId,
    Stripe_Charge_Id__c: refund.chargeId,
    Amount__c: refund.amount.amount,
    Currency__c: refund.amount.currency,
    Status__c: refund.status,
    Reason__c: refund.reason,
  });

const syncDispute = (
  client: SalesforceClient,
  dispute: NonNullable<NormalizedTransaction["disputes"]>[number],
) =>
  client.upsert("Dispute__c", "Stripe_Dispute_Id__c", dispute.disputeId, {
    Name: dispute.disputeId,
    Stripe_Dispute_Id__c: dispute.disputeId,
    Stripe_Charge_Id__c: dispute.chargeId,
    Amount__c: dispute.amount.amount,
    Currency__c: dispute.amount.currency,
    Status__c: dispute.status,
    Reason__c: dispute.reason,
  });

const syncPayout = (
  client: SalesforceClient,
  payout: NonNullable<NormalizedTransaction["payouts"]>[number],
) =>
  client.upsert("Payout__c", "Stripe_Payout_Id__c", payout.payoutId, {
    Name: payout.payoutId,
    Stripe_Payout_Id__c: payout.payoutId,
    Amount__c: payout.amount.amount,
    Currency__c: payout.amount.currency,
    Status__c: payout.status,
    Arrival_Date__c: isoDate(payout.arrivalDate),
    Created_Date__c: isoDate(payout.created),
  });

const buildClient = (context: ServiceContext) => {
  const envRecord = context.env as Record<string, unknown>;
  const loginUrl =
    typeof envRecord.SF_LOGIN_URL === "string" ? envRecord.SF_LOGIN_URL : undefined;
  const apiVersion =
    typeof envRecord.SF_API_VERSION === "string"
      ? envRecord.SF_API_VERSION
      : undefined;

  return new SalesforceClient(
    {
      username: context.env.SF_USERNAME,
      password: context.env.SF_PASSWORD,
      securityToken: context.env.SF_SECURITY_TOKEN,
    },
    {
      loginUrl: loginUrl ?? context.env.SF_LOGIN_URL,
      apiVersion,
    },
  );
};

export const postToSalesforce = async (
  transaction: NormalizedTransaction,
  context: ServiceContext,
): Promise<SalesforceSummary> => {
  if (
    !transaction.payments?.length &&
    !transaction.refunds?.length &&
    !transaction.disputes?.length &&
    !transaction.payouts?.length
  ) {
    return defaultSummary;
  }

  const client = buildClient(context);
  const results: SalesforceSummary[] = [];

  const contact = await upsertContact(client, transaction);
  if (contact) {
    results.push({ action: contact.action, id: contact.id });
  }

  const contactId = contact?.id ?? null;
  const useNpsp = Boolean(context.env.SF_USE_NPSP);

  for (const payment of transaction.payments ?? []) {
    const result = await syncPayment(client, payment, contactId, useNpsp);
    results.push({ action: result.action, id: result.id });
  }

  for (const refund of transaction.refunds ?? []) {
    const result = await syncRefund(client, refund);
    results.push({ action: result.action, id: result.id });
  }

  for (const dispute of transaction.disputes ?? []) {
    const result = await syncDispute(client, dispute);
    results.push({ action: result.action, id: result.id });
  }

  for (const payout of transaction.payouts ?? []) {
    const result = await syncPayout(client, payout);
    results.push({ action: result.action, id: result.id });
  }

  if (results.length === 0) {
    return defaultSummary;
  }

  return results[results.length - 1] ?? defaultSummary;
};
