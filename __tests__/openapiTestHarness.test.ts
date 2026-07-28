import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * The value of this Swagger surface as a manual test harness depends on the examples
 * actually reaching the generated document — a `.openapi({ example })` annotation that
 * silently fails to serialize looks identical to a working one in source. These tests
 * generate the real OpenAPI document the same way the runtime handler does and assert
 * against that, not against the source.
 */
describe('OpenAPI document — staged test harness', () => {
  let doc: any;

  beforeAll(() => {
    // Importing dist/index registers every function against the shared registry.
    require('../dist/index');
    const { registry } = require('azure-functions-openapi/dist/core/registry');
    const { OpenApiGeneratorV31 } = require('@asteasolutions/zod-to-openapi');
    doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: 'test', version: '1.0.0' },
    });
  });

  const operation = (path: string, method: string) => {
    const p = doc.paths?.[path];
    expect(p, `path ${path} missing from generated document`).toBeDefined();
    const op = p[method];
    expect(op, `${method.toUpperCase()} ${path} missing`).toBeDefined();
    return op;
  };

  const queryParams = (path: string, method: string) =>
    (operation(path, method).parameters ?? []).filter((param: any) => param.in === 'query');

  it('generates a document containing the pipeline endpoints', () => {
    expect(doc.paths).toBeDefined();
    for (const path of [
      '/api/health',
      '/api/transaction',
      '/api/stripe/webhook',
      '/api/qbo/manual-sync',
      '/api/stripe/true-up',
      '/api/ops/test-artifact-cleanup',
    ]) {
      expect(Object.keys(doc.paths)).toContain(path);
    }
  });

  it('carries a simulated webhook payload for every stage of the pipeline', () => {
    const examples = operation('/api/stripe/webhook', 'post').requestBody?.content?.[
      'application/json'
    ]?.examples;
    expect(examples).toBeDefined();

    // One per downstream path, so each can be exercised independently.
    const eventTypes = Object.values(examples as Record<string, any>).map(
      (example) => example.value?.type
    );
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'payment_intent.succeeded',
        'refund.created',
        'charge.dispute.closed',
        'payout.paid',
        'invoice.paid',
        'credit_note.created',
      ])
    );
  });

  it('gives the charge payload enough shape to actually drive the handler', () => {
    const examples = operation('/api/stripe/webhook', 'post').requestBody?.content?.[
      'application/json'
    ]?.examples;
    const charge = Object.values(examples as Record<string, any>).find(
      (example) => example.value?.type === 'payment_intent.succeeded'
    )?.value;

    // A bare {id, type} skeleton no-ops long before Salesforce or QuickBooks.
    const chargeObject = charge?.data?.object?.charges?.data?.[0];
    expect(chargeObject).toBeDefined();
    expect(chargeObject.balance_transaction).toBeTruthy();
    expect(chargeObject.billing_details?.email).toBeTruthy();
    expect(chargeObject.payment_method_details?.type).toBeTruthy();
    expect(charge.data.object.amount).toBeGreaterThan(0);
  });

  it('dates the payout example by arrival_date, distinct from created', () => {
    const examples = operation('/api/stripe/webhook', 'post').requestBody?.content?.[
      'application/json'
    ]?.examples;
    const payout = Object.values(examples as Record<string, any>).find(
      (example) => example.value?.type === 'payout.paid'
    )?.value?.data?.object;

    // arrival_date drives the QuickBooks TxnDate on every posting path; keeping the two
    // timestamps distinct means the example exercises the dedup window realistically.
    expect(payout.arrival_date).toBeGreaterThan(payout.created);
  });

  it('tags every webhook example so its records can be cleaned up afterwards', () => {
    const examples = operation('/api/stripe/webhook', 'post').requestBody?.content?.[
      'application/json'
    ]?.examples;

    for (const [name, example] of Object.entries(examples as Record<string, any>)) {
      const serialized = JSON.stringify(example.value);
      expect(serialized, `${name} carries no source_test_tag`).toContain('source_test_tag');
    }
  });

  it('pre-fills query parameters so "Try it out" is runnable, not blank', () => {
    // Without examples the operator has to invent every value by hand, which is where
    // an unintended live-mode or write-mode run comes from.
    const cases: Array<[string, string, string[]]> = [
      ['/api/stripe/true-up', 'post', ['from', 'dryRun']],
      ['/api/qbo/receipts-salesforce-sync', 'post', ['dryRun']],
      ['/api/qbo/customers-salesforce-sync', 'post', ['dryRun']],
      ['/api/ops/daily-reconciliation', 'post', ['dryRun']],
      ['/api/ops/stripe-duplicate-check', 'get', ['dryRun']],
      // Anonymous and record-creating: the mode selector must never be blank.
      ['/api/transaction', 'post', ['mode', 'livemode']],
    ];

    for (const [path, method, expected] of cases) {
      const params = queryParams(path, method);
      for (const name of expected) {
        const param = params.find((p: any) => p.name === name);
        expect(param, `${method.toUpperCase()} ${path} has no ${name} parameter`).toBeDefined();
        expect(
          param.schema?.example ?? param.example,
          `${method.toUpperCase()} ${path} ${name} has no example`
        ).toBeDefined();
      }
    }
  });

  it('defaults the destructive knobs to the safe value', () => {
    const safeDefaults: Array<[string, string, string, string]> = [
      // Reconciliation writes to the general ledger with no idempotency guard.
      ['/api/ops/daily-reconciliation', 'post', 'dryRun', 'true'],
      // Duplicate check can delete ledger documents outright.
      ['/api/ops/stripe-duplicate-check', 'get', 'deleteDuplicates', 'false'],
      ['/api/stripe/true-up', 'post', 'dryRun', 'true'],
      // Anonymous endpoint that creates Stripe and Salesforce records.
      ['/api/transaction', 'post', 'mode', 'test'],
      ['/api/transaction', 'post', 'livemode', 'false'],
    ];

    for (const [path, method, name, expected] of safeDefaults) {
      const param = queryParams(path, method).find((p: any) => p.name === name);
      expect(param, `${path} ${name} missing`).toBeDefined();
      expect(param.schema?.example ?? param.example, `${path} ${name} unsafe default`).toBe(
        expected
      );
    }
  });

  it('documents the webhook signature constraint rather than suggesting TEST_MODE', () => {
    const description = operation('/api/stripe/webhook', 'post').description ?? '';
    expect(description).toMatch(/signature/i);
    expect(description).toMatch(/stripe (trigger|events resend)/i);
    // TEST_MODE is mentioned only as a warning, never as the workaround.
    expect(description).toMatch(/do not enable `?TEST_MODE`?/i);
  });
});
