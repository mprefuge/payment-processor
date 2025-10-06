import { strict as assert } from "node:assert";
import http from "node:http";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { postToSalesforce } from "../../src/services/process/post_sf";
import { NormalizedTransaction } from "../../src/services/process/normalize";
import { ServiceContext } from "../../src/services/shared/types";
import { Env } from "../../src/config/env";

type RecordedRequest = {
  method: string;
  url: string;
  body: unknown;
};

type RecordStore = {
  id: string;
  body: Record<string, unknown>;
};

const createServer = async () => {
  let counter = 1;
  const records = new Map<string, RecordStore>();
  const requests: RecordedRequest[] = [];

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

    const url = req.url ?? "";

    if (req.method === "POST" && url === "/services/oauth2/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "token",
          instance_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          token_type: "Bearer",
        }),
      );
      return;
    }

    if (url.startsWith("/services/data/")) {
      const [path] = url.split("?");
      const parts = path.split("/").filter(Boolean);
      const objectName = parts[4];

      if (parts[3] === "query") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ totalSize: 0, done: true, records: [] }));
        return;
      }

      let externalField = "Id";
      let externalValue = "";

      if (parts.length === 7) {
        externalField = decodeURIComponent(parts[5]);
        externalValue = decodeURIComponent(parts[6]);
      } else {
        externalValue = decodeURIComponent(parts[5]);
      }

      const key = `${objectName}:${externalField}:${externalValue}`;
      const existing = records.get(key);

      if (req.method === "PATCH") {
        const incoming =
          body && typeof body === "object"
            ? (body as Record<string, unknown>)
            : ({} as Record<string, unknown>);

        if (existing) {
          records.set(key, { id: existing.id, body: { ...existing.body, ...incoming } });
          res.writeHead(204, { "Content-Type": "application/json" });
          res.end();
          return;
        }

        const id = `${objectName.slice(0, 3)}${String(counter).padStart(6, "0")}`;
        counter += 1;
        records.set(key, { id, body: incoming });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id }));
        return;
      }

      if (req.method === "GET") {
        if (!existing) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: existing.id, ...existing.body }));
        return;
      }
    }

    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unhandled" }));
  });

  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const createContext = (overrides?: Partial<Env>): ServiceContext => ({
  env: {
    STRIPE_SECRET: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec",
    SF_CLIENT_ID: "client",
    SF_CLIENT_SECRET: "secret",
    SF_USERNAME: "user",
    SF_PASSWORD: "pass",
    QBO_CLIENT_ID: "qbo",
    QBO_CLIENT_SECRET: "qbo_secret",
    QBO_ENV: "sandbox",
    QBO_REALM_ID: "realm",
    ENABLE_SF: true,
    ENABLE_QBO: false,
    QBO_FEES_AGGREGATION: "per_tx",
    DOCNUM_PREFIX: "stripe",
    SF_USE_NPSP: false,
    QBO_ACCOUNT_STRIPE_CLEARING: "1",
    QBO_ACCOUNT_CHECKING: "2",
    QBO_ACCOUNT_STRIPE_FEES: "3",
    QBO_ITEM_DONATION: "donation",
    DATABASE_URL: "postgres://test",
    AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    ...(overrides ?? {}),
  } as Env,
});

const paymentTransaction = (): NormalizedTransaction => ({
  payments: [
    {
      chargeId: "ch_123",
      customerId: "cus_123",
      created: new Date("2024-01-01T00:00:00Z").toISOString(),
      amount: { amount: 5000, currency: "usd" },
      net: undefined,
      fee: undefined,
      description: "Donation",
      metadata: { customer_email: "donor@example.com", customer_name: "Jane Doe" },
    },
  ],
});

const paymentWithoutCustomer = (): NormalizedTransaction => ({
  payments: [
    {
      chargeId: "ch_124",
      created: new Date("2024-01-02T00:00:00Z").toISOString(),
      amount: { amount: 2500, currency: "usd" },
      description: "Donation",
      metadata: { email: "fallback@example.com" },
    },
  ],
});

const run = async () => {
  const server = await createServer();

  const context = createContext({ SF_LOGIN_URL: server.baseUrl });
  const result = await postToSalesforce(paymentTransaction(), context);

  assert.equal(result.action, "created");
  assert.ok(result.id, "should return created id");

  const contactRequest = server.requests.find((request) =>
    request.url.includes("Contact/stripe_customer_id__c/cus_123"),
  );
  assert.ok(contactRequest, "contact upsert by customer id should occur");

  const paymentRequest = server.requests.find((request) =>
    request.url.includes("Payment__c/Stripe_Charge_Id__c/ch_123"),
  );
  assert.ok(paymentRequest, "payment upsert should occur");

  const rerun = await postToSalesforce(paymentTransaction(), context);
  assert.equal(rerun.action, "updated", "second run should update existing record");

  const contactUpdates = server.requests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.url.includes("Contact/stripe_customer_id__c/cus_123"),
  );
  assert.equal(contactUpdates.length, 2, "contact upsert should run twice");

  const paymentUpdates = server.requests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.url.includes("Payment__c/Stripe_Charge_Id__c/ch_123"),
  );
  assert.equal(paymentUpdates.length, 2, "payment upsert should run twice");

  const fallbackContext = createContext({ SF_LOGIN_URL: server.baseUrl });
  const fallbackResult = await postToSalesforce(paymentWithoutCustomer(), fallbackContext);
  assert.equal(fallbackResult.action, "created");

  const fallbackRequest = server.requests.find((request) =>
    request.url.includes("Contact/Email/fallback%40example.com"),
  );
  assert.ok(fallbackRequest, "fallback upsert should use email path");

  await server.close();
};

run()
  .then(() => {
    console.log("salesforce.post.spec.ts passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
