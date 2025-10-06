# Stripe True-Up Endpoint Architecture

## Request Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Application                          │
│                                                                     │
│  POST /api/sync/stripe/true-up                                     │
│  {                                                                  │
│    "since": "2024-01-01T00:00:00Z",                               │
│    "resources": ["payouts"],                                       │
│    "dryRun": false                                                 │
│  }                                                                  │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    stripeTrueUp/index.js                           │
│                                                                     │
│  1. Validate request body                                          │
│  2. Initialize Stripe client (test/live mode)                      │
│  3. Create RateLimiter instance                                    │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│              For Each Resource Type (payouts, etc.)                │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  RateLimiter.executeWithRetry()                              │  │
│  │  ├─ Try: fetchStripePayoutsSince(stripe, since)             │  │
│  │  ├─ Catch StripeRateLimitError:                              │  │
│  │  │   ├─ Calculate delay (exponential + jitter)               │  │
│  │  │   ├─ Sleep (1s → 2s → 4s → ...)                          │  │
│  │  │   └─ Retry (max 3 attempts)                               │  │
│  │  └─ Return: Array of payouts                                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│        services/accounting/stripe-qbo/fetchStripe.js               │
│                                                                     │
│  fetchStripePayoutsSince(stripe, since, options)                   │
│  ├─ normalizeSince() → Unix timestamp                             │
│  ├─ buildPayoutFetcher() → createListFetcher()                    │
│  └─ fetchAll(stripe.payouts.list, params, logger)                 │
│      │                                                              │
│      ├─ Loop: while (has_more)                                     │
│      │   ├─ Call Stripe API with starting_after cursor            │
│      │   ├─ Collect response.data                                 │
│      │   ├─ Update starting_after = last item ID                  │
│      │   └─ Break if page >= MAX_AUTOPAGE (1000)                  │
│      │                                                              │
│      └─ Return: All fetched items                                  │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Back to stripeTrueUp/index.js                         │
│                                                                     │
│  For Each Payout:                                                  │
│  ├─ Filter: status === 'paid' only                                │
│  ├─ Check: syncLedger.getSync(accountId, payoutId)               │
│  │   └─ If already posted → Skip                                  │
│  ├─ If dryRun → Skip processing, increment fetched count          │
│  └─ Else → Process payout                                         │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│           stripeWebhook/payoutProcessor.js                         │
│                                                                     │
│  processPayoutPaid(context, payout, accountId, eventId)           │
│  ├─ Check accounting sync enabled                                 │
│  ├─ Validate configuration                                        │
│  ├─ Check existing sync (idempotency)                             │
│  ├─ Initialize accounting provider (QBO, etc.)                    │
│  ├─ Create PayoutSyncService                                      │
│  └─ Call processPayoutJob()                                       │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│         stripeWebhook/payoutProcessor.js (continued)               │
│                                                                     │
│  processPayoutJob(context, payoutId, accountId, service, eventId) │
│  ├─ 1. pullPayout() → Fetch payout + balance transactions         │
│  ├─ 2. summarize() → Aggregate charges, refunds, fees             │
│  ├─ 3. validateTotals() → Ensure summary matches payout           │
│  ├─ 4. generatePostingInstructions() → Create journal entries     │
│  ├─ 5. postToAccounting() → Post to QBO/accounting system         │
│  ├─ 6. syncLedger.recordSync() → Save sync record                 │
│  └─ 7. syncPayoutToCrm() → Optional CRM sync                      │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Accounting System (QBO)                         │
│                                                                     │
│  - Journal Entry created                                           │
│  - Transfer created                                                │
│  - Documents linked to payout                                      │
└─────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Response to Client                            │
│                                                                     │
│  {                                                                  │
│    "message": "True-up completed",                                 │
│    "results": {                                                     │
│      "payouts": {                                                   │
│        "fetched": 15,                                              │
│        "processed": 12,                                            │
│        "skipped": 3,                                               │
│        "errors": []                                                │
│      }                                                              │
│    },                                                               │
│    "summary": {                                                     │
│      "totalFetched": 15,                                           │
│      "totalProcessed": 12,                                         │
│      "totalSkipped": 3,                                            │
│      "totalErrors": 0                                              │
│    }                                                                │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Rate Limiting Strategy

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Rate Limit Encounter                        │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
                      ▼
                 Attempt 0
                      │
              ┌───────┴───────┐
              │ Stripe API    │
              │ Rate Limited  │
              └───────┬───────┘
                      │
                      ▼
              Calculate Delay:
              2^0 * 1000ms = 1000ms
              + Random(0-1000ms)
              = ~1000-2000ms
                      │
                      ▼
              ┌───────────────┐
              │  Sleep 1.5s   │
              └───────┬───────┘
                      │
                      ▼
                 Attempt 1
                      │
              ┌───────┴───────┐
              │ Stripe API    │
              │ Rate Limited  │
              └───────┬───────┘
                      │
                      ▼
              Calculate Delay:
              2^1 * 1000ms = 2000ms
              + Random(0-1000ms)
              = ~2000-3000ms
                      │
                      ▼
              ┌───────────────┐
              │  Sleep 2.3s   │
              └───────┬───────┘
                      │
                      ▼
                 Attempt 2
                      │
              ┌───────┴───────┐
              │ Stripe API    │
              │    SUCCESS    │
              └───────┬───────┘
                      │
                      ▼
                ┌─────────┐
                │ Return  │
                │ Results │
                └─────────┘
```

## Pagination Flow

```
┌────────────────────────────────────────────────────────────────┐
│                     fetchAll() Function                        │
└────────────────────┬───────────────────────────────────────────┘
                     │
                     ▼
              ┌──────────────┐
              │  page = 0    │
              │  items = []  │
              │  cursor = ∅  │
              └──────┬───────┘
                     │
                     ▼
           ┌─────────────────────┐
           │ Stripe API Request  │
           │ { starting_after:   │
           │   cursor,           │
           │   limit: 100 }      │
           └─────────┬───────────┘
                     │
                     ▼
           ┌─────────────────────┐
           │   Response:         │
           │   {                 │
           │     data: [...],    │
           │     has_more: true  │
           │   }                 │
           └─────────┬───────────┘
                     │
                     ▼
           ┌─────────────────────┐
           │ Add data to items   │
           │ page++              │
           └─────────┬───────────┘
                     │
                     ▼
           ┌─────────────────────┐
           │  has_more = true?   │
           │  page < 1000?       │
           │  data.length > 0?   │
           └─────────┬───────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
        YES                     NO
         │                       │
         ▼                       ▼
    ┌─────────┐          ┌──────────┐
    │ cursor  │          │  Return  │
    │ = last  │          │  items   │
    │ item ID │          └──────────┘
    └────┬────┘
         │
         └─────────────┐
                       │
                       ▼
             ┌─────────────────┐
             │   Loop again    │
             └─────────────────┘
```

## Component Interaction

```
┌─────────────────────────────────────────────────────────────────┐
│                     stripeTrueUp Endpoint                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ RateLimiter  │  │  fetchStripe │  │ Idempotency  │         │
│  │              │  │   Utilities  │  │   Checker    │         │
│  │ - Retry      │  │ - Pagination │  │ - SyncLedger │         │
│  │ - Backoff    │  │ - Cursor     │  │ - Skip check │         │
│  │ - Jitter     │  │ - Limit 100  │  │              │         │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         │
│         │                 │                  │                 │
│         └─────────────────┴──────────────────┘                 │
│                           │                                    │
└───────────────────────────┼────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Payout Processor Module                        │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ Accounting   │  │   Payout     │  │     CRM      │         │
│  │   Config     │  │    Sync      │  │   Service    │         │
│  │              │  │   Service    │  │              │         │
│  │ - Validate   │  │ - Pull       │  │ - Salesforce │         │
│  │ - Provider   │  │ - Summarize  │  │ - HubSpot    │         │
│  │ - Accounts   │  │ - Validate   │  │              │         │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         │
│         │                 │                  │                 │
│         └─────────────────┴──────────────────┘                 │
│                           │                                    │
└───────────────────────────┼────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  External Systems                               │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Stripe API  │  │ QuickBooks   │  │  Salesforce  │         │
│  │              │  │    Online    │  │     CRM      │         │
│  │ - Payouts    │  │ - Journal    │  │ - Payout     │         │
│  │ - Charges    │  │ - Transfer   │  │   Records    │         │
│  │ - Refunds    │  │ - Deposit    │  │              │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

## Error Handling Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Error Occurs                             │
└─────────────────────┬───────────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          │                       │
     Rate Limit                Other
       Error                   Error
          │                       │
          ▼                       ▼
    ┌──────────┐          ┌──────────────┐
    │  Retry   │          │ Log & Track  │
    │  Logic   │          │   in Error   │
    │          │          │    Array     │
    └────┬─────┘          └──────┬───────┘
         │                       │
         ▼                       ▼
   ┌──────────┐          ┌──────────────┐
   │ Success? │          │ Continue to  │
   └────┬─────┘          │ Next Payout  │
        │                └──────────────┘
   ┌────┴────┐
  YES       NO
   │         │
   ▼         ▼
Process   Add to
 Payout   Errors
          Array
```
