import { strict as assert } from "node:assert";

import {
  CheckoutRequestSchema,
  buildCheckoutSessionParams,
} from "../../src/services/checkout/session";

export const runCheckoutSessionSpec = () => {
  const payload = {
    transactionType: "Donation",
    email: "customer@example.com",
    firstname: "John",
    lastname: "Doe",
    phone: "+1234567890",
    amount: 2500,
    frequency: "onetime",
    category: "General",
    coverFee: false,
    address: {
      line1: "123 Main St",
      line2: "Apt 4",
      city: "New York",
      state: "NY",
      postal_code: "10001",
      country: "us",
    },
  };

  const parsed = CheckoutRequestSchema.parse(payload);
  const params = buildCheckoutSessionParams(parsed, {
    successUrl: "https://example.org/success",
    cancelUrl: "https://example.org/cancel",
  });

  assert.equal(params.mode, "payment");
  assert.equal(params.success_url, "https://example.org/success");
  assert.equal(params.cancel_url, "https://example.org/cancel");
  assert.equal(params.customer_email, "customer@example.com");
  assert.equal(params.line_items?.[0]?.price_data?.unit_amount, 2500);
  assert.equal(params.line_items?.[0]?.price_data?.currency, "usd");
  assert.equal(params.line_items?.[0]?.price_data?.product_data?.name, "Donation - General");
  assert.equal(params.payment_intent_data?.metadata?.firstname, "John");
  assert.equal(params.payment_intent_data?.metadata?.address_country, "US");

  const invalid = CheckoutRequestSchema.safeParse({ ...payload, email: "not-an-email" });
  assert.ok(!invalid.success);
};
