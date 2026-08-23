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

  describe('the /api/ops/test/* rehearsal endpoints', () => {
    const HARNESS_PATHS = [
      '/api/ops/test/quickbooks',
      '/api/ops/test/salesforce',
      '/api/ops/test/stripe',
      '/api/ops/test/donation',
    ];

    it('registers all four behind a function key, never anonymously', () => {
      for (const path of HARNESS_PATHS) {
        const op = operation(path, 'post');
        const schemes = (op.security ?? []).flatMap((entry: any) => Object.keys(entry));
        expect(schemes.length, `${path} is unauthenticated`).toBeGreaterThan(0);
        expect(schemes).toContain('ApiKeyAuth');
      }
    });

    it('defaults dryRun to true on every one of them', () => {
      for (const path of HARNESS_PATHS) {
        const param = queryParams(path, 'post').find((p: any) => p.name === 'dryRun');
        expect(param, `${path} has no dryRun parameter`).toBeDefined();
        expect(param.schema?.example ?? param.example, `${path} dryRun unsafe default`).toBe(
          'true'
        );
      }
    });

    it('prefills a working donation payload so "Try it out" needs no source reading', () => {
      for (const path of HARNESS_PATHS) {
        const content = operation(path, 'post').requestBody?.content?.['application/json'];
        expect(content?.example, `${path} has no request example`).toBeDefined();

        const donation = content.example.donation;
        expect(donation, `${path} example carries no donation`).toBeDefined();
        expect(typeof donation.grossCents).toBe('number');
        expect(donation.donor?.email).toMatch(/@/);

        const examples = Object.values(content.examples ?? {}) as any[];
        expect(examples.length, `${path} has no named examples`).toBeGreaterThan(0);
      }
    });

    it('carries an example modelling an unsettled charge, where the fee is unknown', () => {
      const examples = operation('/api/ops/test/quickbooks', 'post').requestBody?.content?.[
        'application/json'
      ]?.examples;
      const unsettled = Object.values(examples as Record<string, any>).find((example) =>
        /not settled|unsettled/i.test(example.summary ?? '')
      );

      expect(unsettled).toBeDefined();
      // The point of the example is the ABSENCE of the fee, so it must not carry one.
      expect(unsettled.value.donation).not.toHaveProperty('processorFeeCents');
    });

    it('draws the read/write line a dry run actually holds, on every endpoint', () => {
      // A dry run promises no outbound WRITE, not no outbound call. The two differ on
      // exactly one path — a chargeId, which only Stripe can describe — and an operator
      // deciding whether a call is safe should not have to read source to learn which.
      for (const path of HARNESS_PATHS) {
        const description = operation(path, 'post').description ?? '';
        expect(description, `${path} does not describe what a dry run does`).toMatch(
          /what a dry run does and does not do/i
        );
        expect(description, `${path} does not say a dry run writes nothing`).toMatch(
          /no outbound \*\*write\*\*/i
        );
        expect(description, `${path} does not point at outboundReads`).toMatch(/outboundReads/);
      }

      // Only the QuickBooks endpoint reads on a dry run, and it must say why rather than
      // leaving the exception to be discovered.
      const quickbooks = operation('/api/ops/test/quickbooks', 'post').description ?? '';
      expect(quickbooks).toMatch(/chargeId/);
      expect(quickbooks).toMatch(/only Stripe can describe an existing charge/i);

      // The other three take an inline payload only, so they keep the stronger property.
      for (const path of HARNESS_PATHS.filter((p) => !p.endsWith('quickbooks'))) {
        expect(
          operation(path, 'post').description ?? '',
          `${path} does not claim the stronger no-call property`
        ).toMatch(/no outbound call of \*\*any\*\* kind/i);
      }
    });

    it('shows the chargeId example as a plain dry run, not a write-enabled one', () => {
      // Previewing a real charge is what this endpoint is chiefly for. An example that
      // reached for dryRun=false would teach every operator to switch writing on to look.
      const examples = operation('/api/ops/test/quickbooks', 'post').requestBody?.content?.[
        'application/json'
      ]?.examples;
      const withCharge = Object.values(examples as Record<string, any>).find(
        (example) => example.value?.chargeId
      );

      expect(withCharge, 'no example supplies a chargeId').toBeDefined();
      expect(withCharge.value.dryRun).toBe(true);
    });

    it('states plainly what a non-dry-run call would touch', () => {
      const expectations: Array<[string, RegExp]> = [
        ['/api/ops/test/quickbooks', /QuickBooks, and nothing else/i],
        ['/api/ops/test/salesforce', /Salesforce, and nothing else/i],
        ['/api/ops/test/stripe', /only in test mode/i],
        ['/api/ops/test/donation', /dry-run only/i],
      ];

      for (const [path, pattern] of expectations) {
        const description = operation(path, 'post').description ?? '';
        expect(description, `${path} does not describe dryRun=false`).toMatch(
          /what `?dryRun=false`? touches/i
        );
        expect(description, `${path} does not say what it touches`).toMatch(pattern);
        expect(description, `${path} does not mention the cleanup tag`).toMatch(
          /source_test_tag|test-artifact-cleanup/i
        );
      }
    });
  });

  it('documents the webhook signature constraint rather than suggesting TEST_MODE', () => {
    const description = operation('/api/stripe/webhook', 'post').description ?? '';
    expect(description).toMatch(/signature/i);
    expect(description).toMatch(/stripe (trigger|events resend)/i);
    // TEST_MODE is mentioned only as a warning, never as the workaround.
    expect(description).toMatch(/do not enable `?TEST_MODE`?/i);
  });
});
