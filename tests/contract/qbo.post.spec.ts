import { strict as assert } from "node:assert";
import http from "node:http";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { postToQuickBooks } from "../../src/services/process/post_qbo";
import { NormalizedTransaction } from "../../src/services/process/normalize";
import { ServiceContext } from "../../src/services/shared/types";
import { Env } from "../../src/config/env";
import { docnum_fee_tx, docnum_payout, docnum_salesreceipt, docnum_dispute } from "../../src/services/shared/doc_numbers";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

type StoredRecord = { Id: string } & Record<string, unknown>;

type RecordStore = {
  SalesReceipt: Map<string, StoredRecord>;
  RefundReceipt: Map<string, StoredRecord>;
  JournalEntry: Map<string, StoredRecord>;
  Transfer: Map<string, StoredRecord>;
};

type ServerInstance = {
  baseUrl: string;
  requests: RecordedRequest[];
  records: RecordStore;
  close: () => Promise<void>;
};

const resourceToDocType: Record<string, keyof RecordStore> = {
  salesreceipt: "SalesReceipt",
  refundreceipt: "RefundReceipt",
  journalentry: "JournalEntry",
  transfer: "Transfer",
};

const createServer = async (): Promise<ServerInstance> => {
  let counter = 1;
  const requests: RecordedRequest[] = [];
  const records: RecordStore = {
    SalesReceipt: new Map(),
    RefundReceipt: new Map(),
    JournalEntry: new Map(),
    Transfer: new Map(),
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });

    const url = new URL(req.url ?? "", "http://qbo.local");

    if (req.method === "POST" && url.pathname === "/oauth/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: `token-${counter++}`,
          refresh_token: "refresh-token",
          expires_in: 3600,
        }),
      );
      return;
    }

    const match = url.pathname.match(/\/v3\/company\/[^/]+\/(\w+)/);
    const resource = match?.[1]?.toLowerCase();

    if (req.method === "GET" && resource === "query") {
      const query = url.searchParams.get("query") ?? "";
      const docTypeMatch = query.match(/from\s+(\w+)/i);
      const docNumberMatch = query.match(/DocNumber\s*=\s*'([^']+)'/i);
      const docType = docTypeMatch?.[1] as keyof RecordStore | undefined;
      const docNumber = docNumberMatch?.[1] ?? "";
      const existing = docType ? records[docType].get(docNumber) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          QueryResponse: {
            [docType ?? "Unknown"]: existing ? [existing] : [],
          },
        }),
      );
      return;
    }

    if (req.method === "POST" && resource && resource in resourceToDocType) {
      const docType = resourceToDocType[resource];
      const payload = (body ?? {}) as Record<string, unknown>;
      const docNumber = String(payload.DocNumber ?? "");
      const id = `${docType.slice(0, 2).toUpperCase()}-${counter++}`;
      const record = { Id: id, ...payload } as StoredRecord;
      records[docType].set(docNumber, record);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ [docType]: record }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    records,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

const createContext = (
  baseUrl: string,
  overrides?: Partial<Env>,
): ServiceContext => ({
  env: {
    STRIPE_SECRET: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec",
    SF_CLIENT_ID: "sf",
    SF_CLIENT_SECRET: "sf_secret",
    SF_USERNAME: "sf_user",
    SF_PASSWORD: "sf_pass",
    QBO_CLIENT_ID: "qbo",
    QBO_CLIENT_SECRET: "qbo_secret",
    QBO_ENV: "sandbox",
    QBO_REALM_ID: "realm",
    ENABLE_SF: false,
    ENABLE_QBO: true,
    QBO_FEES_AGGREGATION: "per_tx",
    DOCNUM_PREFIX: "stripe",
    SF_USE_NPSP: false,
    QBO_ACCOUNT_STRIPE_CLEARING: "clearing",
    QBO_ACCOUNT_CHECKING: "checking",
    QBO_ACCOUNT_STRIPE_FEES: "fees",
    QBO_ITEM_DONATION: "donation",
    DATABASE_URL: "postgres://test",
    AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    QBO_API_BASE_URL: baseUrl,
    QBO_TOKEN_URL: `${baseUrl}/oauth/token`,
    QBO_REFRESH_TOKEN: "refresh",
    ...(overrides ?? {}),
  } as Env & Record<string, unknown>,
});

const paymentTransaction = (): NormalizedTransaction => ({
  payments: [
    {
      chargeId: "ch_123",
      created: new Date("2024-01-01T00:00:00Z").toISOString(),
      amount: { amount: 5000, currency: "usd" },
      description: "Donation",
      metadata: {},
      balanceTransactionId: "txn_123",
      balanceSummary: {
        gross: { amount: 5000, currency: "usd" },
        fee_total: { amount: 200, currency: "usd" },
        net: { amount: 4800, currency: "usd" },
        available_on: new Date("2024-01-02T00:00:00Z").toISOString(),
      },
    },
  ],
});

const refundTransaction = (): NormalizedTransaction => ({
  refunds: [
    {
      refundId: "re_123",
      chargeId: "ch_123",
      created: new Date("2024-01-05T00:00:00Z").toISOString(),
      amount: { amount: 1500, currency: "usd" },
      status: "succeeded",
      reason: "requested_by_customer",
      metadata: {},
    },
  ],
});

const payoutTransaction = (): NormalizedTransaction => ({
  payouts: [
    {
      payoutId: "po_123",
      amount: { amount: 4800, currency: "usd" },
      created: new Date("2024-01-03T00:00:00Z").toISOString(),
      arrivalDate: new Date("2024-01-05T00:00:00Z").toISOString(),
      status: "paid",
    },
  ],
});

const disputeTransaction = (): NormalizedTransaction => ({
  disputes: [
    {
      disputeId: "dp_123",
      chargeId: "ch_123",
      created: new Date("2024-01-04T00:00:00Z").toISOString(),
      amount: { amount: 1500, currency: "usd" },
      status: "lost",
      reason: "fraudulent",
      metadata: {},
    },
  ],
});

const run = async () => {
  const server = await createServer();
  const context = createContext(server.baseUrl);

  const paymentResult = await postToQuickBooks(
    paymentTransaction(),
    "sales_receipt",
    context,
  );
  assert.equal(paymentResult.action, "created");
  assert.equal(paymentResult.doc_type, "SalesReceipt");
  assert.ok(paymentResult.doc_id, "should return doc id for sales receipt");

  const salesDocNumber = docnum_salesreceipt("ch_123");
  const salesReceipt = server.records.SalesReceipt.get(salesDocNumber);
  assert.ok(salesReceipt, "sales receipt should be stored");
  assert.equal(
    (salesReceipt?.DepositToAccountRef as { value: string }).value,
    context.env.QBO_ACCOUNT_STRIPE_CLEARING,
  );

  const feeDocNumber = docnum_fee_tx("txn_123");
  const feeEntry = server.records.JournalEntry.get(feeDocNumber);
  assert.ok(feeEntry, "fee journal entry should be created");
  const feeLines = (feeEntry?.Line as Array<Record<string, any>>) ?? [];
  const feeCredit = feeLines.find(
    (line) => line.JournalEntryLineDetail?.PostingType === "Credit",
  );
  const feeDebit = feeLines.find(
    (line) => line.JournalEntryLineDetail?.PostingType === "Debit",
  );
  assert.equal(
    feeCredit?.JournalEntryLineDetail?.AccountRef?.value,
    context.env.QBO_ACCOUNT_STRIPE_CLEARING,
  );
  assert.equal(
    feeDebit?.JournalEntryLineDetail?.AccountRef?.value,
    context.env.QBO_ACCOUNT_STRIPE_FEES,
  );

  const rerun = await postToQuickBooks(paymentTransaction(), "sales_receipt", context);
  assert.equal(rerun.action, "noop", "second run should be idempotent");
  const salesPosts = server.requests.filter(
    (req) => req.method === "POST" && req.url.includes("salesreceipt"),
  );
  assert.equal(salesPosts.length, 1, "sales receipt should be posted once");

  const refundResult = await postToQuickBooks(
    refundTransaction(),
    "refund_receipt",
    context,
  );
  assert.equal(refundResult.action, "created");
  assert.equal(refundResult.doc_type, "RefundReceipt");

  const payoutResult = await postToQuickBooks(
    payoutTransaction(),
    "transfer",
    context,
  );
  assert.equal(payoutResult.action, "created");
  assert.equal(payoutResult.doc_type, "Transfer");
  const transferDocNumber = docnum_payout("po_123");
  const transfer = server.records.Transfer.get(transferDocNumber);
  assert.ok(transfer, "transfer should be stored");
  assert.equal(
    (transfer?.FromAccountRef as { value: string }).value,
    context.env.QBO_ACCOUNT_STRIPE_CLEARING,
  );
  assert.equal(
    (transfer?.ToAccountRef as { value: string }).value,
    context.env.QBO_ACCOUNT_CHECKING,
  );

  const disputeResult = await postToQuickBooks(
    disputeTransaction(),
    "dispute_entry",
    context,
  );
  assert.equal(disputeResult.action, "created");
  assert.equal(disputeResult.doc_type, "JournalEntry");
  const disputeDocNumber = docnum_dispute("dp_123", "lost");
  const disputeEntry = server.records.JournalEntry.get(disputeDocNumber);
  assert.ok(disputeEntry, "dispute journal entry should be stored");
  const disputeLines = (disputeEntry?.Line as Array<Record<string, any>>) ?? [];
  const disputeDebit = disputeLines.find(
    (line) => line.JournalEntryLineDetail?.PostingType === "Debit",
  );
  const disputeCredit = disputeLines.find(
    (line) => line.JournalEntryLineDetail?.PostingType === "Credit",
  );
  assert.equal(
    disputeDebit?.JournalEntryLineDetail?.AccountRef?.value,
    context.env.QBO_ACCOUNT_STRIPE_FEES,
  );
  assert.equal(
    disputeCredit?.JournalEntryLineDetail?.AccountRef?.value,
    context.env.QBO_ACCOUNT_STRIPE_CLEARING,
  );

  await server.close();
  console.log("qbo.post.spec.ts passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
