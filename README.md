# Payment Processing Azure Function (V2 Orchestrator)

This repository hosts the second-generation payment processing orchestrator
for Stripe webhooks. The implementation is written in TypeScript and ships as
an Azure Functions app. It normalizes incoming Stripe events, applies
idempotent ledger semantics, and then routes canonical data to the downstream
QuickBooks Online and Salesforce integrations.

## Entry points

The Functions host exposes two HTTP endpoints:

| Route | Description |
|-------|-------------|
| `POST /api/transaction` | Primary Stripe webhook entry point backed by the new orchestrator. |
| `GET /api/health` | Lightweight readiness probe for infrastructure dependencies. |

All new automation and playbooks should target `/api/transaction`. The legacy
JavaScript handlers have been removed in favour of the consolidated TypeScript
implementation that lives in `src/app/processTransaction`.

## Getting started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure local settings**

   Copy `local.settings.json.template` to `local.settings.json` and fill in the
   required values (Stripe secrets, Salesforce and QuickBooks credentials, and
   storage connection strings). The TypeScript environment schema lives in
   `src/config/env.ts` and documents every required variable.

3. **Run the Functions host**

   ```bash
   npm start
   ```

   By default the Functions runtime listens on
   `http://localhost:7071/api/transaction`.

## Operational report for the V2 processor

A CLI helper is available to verify production adoption of the V2 flow. The
script scans JSON/JSONL log exports alongside optional payout residual metrics
and asserts the four go/no-go gates required before removing the legacy
handlers.

```bash
npm run report:v2 -- \
  --logs ./path/to/log-export \
  --metrics ./path/to/payout-metrics.json
```

The report filters the last seven days of log lines that include
`USE_V2_PROCESSOR=true` and confirms:

1. Zero fallbacks to the legacy orchestrator.
2. No duplicate QuickBooks `DocNumber` usage.
3. No Salesforce External-ID upsert conflicts.
4. Zero residual amounts on closed payouts (when payout metrics are supplied).

A non-zero exit code indicates at least one guardrail failed and the emitted
report details the offending records.

## Testing the new flow

The repository ships with lightweight unit and integration coverage that only
touches the new TypeScript surface area. To execute the suite:

```bash
npm test
```

This command runs the following checks via `ts-node`:

- Normalisation contract tests for Stripe payloads.
- Ledger repository unit tests.
- Route resolution tests for QuickBooks and Salesforce decisions.
- An integration test that exercises the `processTransaction` orchestrator end
  to end (with downstream systems disabled).

All tests run entirely in-memory and require no external services.

## Observability and runbooks

- Every log line emitted by the orchestrator includes a correlation ID to aid
  cross-system tracing.
- Metrics are exposed via the lightweight in-memory counter service located at
  `src/services/shared/metrics.ts`.
- Closed payout reconciliation residuals should always converge to zero; the
  reporting script described above can be wired into scheduled monitors or
  deployment pipelines.

For detailed architecture notes consult the ADRs under `docs/adr/` and the
module-level documentation embedded throughout `src/services`.
