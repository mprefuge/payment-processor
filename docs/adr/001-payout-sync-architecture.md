# ADR 001: Stripe Payout Sync Architecture

## Status

Accepted

## Context

The payment processor needed to sync Stripe payouts to accounting systems (QuickBooks Online, Xero, Sage, etc.) to automate bookkeeping and reduce manual data entry. The solution needed to:

1. Handle Stripe webhooks reliably with fast acknowledgment
2. Support multiple accounting providers through a common interface
3. Ensure idempotency and prevent duplicate postings
4. Provide comprehensive reconciliation and validation
5. Support multi-account/Connect scenarios
6. Maintain audit trail for compliance

## Decision

We have decided to implement a **webhook-first, provider-agnostic accounting sync architecture** with the following key design decisions:

### 1. Journal Entry + Transfer vs. Deposit

**Decision**: Use **Journal Entry + Transfer** as the default posting strategy, with Deposit as an alternative.

**Rationale**:
- **JE captures activity detail**: Separate lines for charges, refunds, fees, disputes allow for detailed reporting
- **Transfer is explicit**: Clear movement of funds from Stripe Clearing to Operating Bank
- **Better reconciliation**: Activity details match Stripe reports, easier to reconcile
- **Flexibility**: Users can choose Deposit strategy via configuration if preferred

**Trade-offs**:
- More documents per payout (2 instead of 1)
- Slightly more API calls to accounting provider
- But: Better audit trail and reporting clarity

### 2. Clearing Account Strategy

**Decision**: Use a dedicated **Stripe Clearing** bank account in the chart of accounts.

**Rationale**:
- **Net effect tracking**: Clearing account balance should be zero after all postings and transfers
- **Reconciliation**: Easy to identify discrepancies when clearing doesn't zero out
- **Activity aggregation**: All Stripe activity flows through one account
- **Standard accounting practice**: Matches how businesses typically handle payment processor accounts

**Configuration**: Account name is configurable via `ACCOUNTING_STRIPE_CLEARING_ACCOUNT`

### 3. Provider Abstraction

**Decision**: Create **BaseAccountingProvider** interface with provider-specific implementations.

**Rationale**:
- **Extensibility**: Easy to add Xero, Sage, or custom providers
- **Separation of concerns**: Domain logic separate from provider-specific API calls
- **Testing**: Easy to mock for unit tests
- **Consistent interface**: All providers implement same methods

**Key abstraction points**:
- `upsertJournalEntry()` - Idempotent JE creation
- `upsertTransfer()` - Idempotent transfer creation
- `upsertDeposit()` - Alternative posting method
- `ensureChartOfAccounts()` - Account management
- `healthCheck()` - Connectivity verification

### 4. Webhook and Job Design

**Decision**: **Fast webhook ACK with async job processing** (ready for queues, synchronous initially).

**Rationale**:
- **Stripe requirement**: Webhooks must respond in <2s or Stripe retries
- **Heavy work**: Fetching balance transactions and posting to accounting can take time
- **Reliability**: Queue-based processing allows retries without webhook timeouts
- **Scalability**: Decouples webhook receipt from processing

**Implementation**:
- Webhook: Verify signature, dedupe, record event, enqueue job, return 200
- Job: Pull payout, summarize, validate, post, record ledger
- Currently synchronous but designed for queue-based processing

### 5. Multicurrency Policy

**Decision**: **Single currency initially**, with architecture ready for multicurrency.

**Rationale**:
- **Simplicity**: Most businesses start with single currency
- **Complexity**: Multicurrency requires exchange rate management and provider support
- **Future-ready**: Architecture supports adding multicurrency via:
  - ExchangeRate field in posting instructions
  - Currency conversion service
  - Provider-specific multicurrency handling

**Path forward**: Add multicurrency when needed by specific use case

## Consequences

### Positive

1. **Clean separation of concerns**: Domain logic, provider interface, and implementation are separate
2. **Easy to extend**: Adding new providers is straightforward
3. **Comprehensive audit**: Full trail from webhook to accounting documents
4. **Idempotent**: Safe to replay events and re-run sync
5. **Configurable**: Posting strategy and account mappings are flexible
6. **Testable**: Clear interfaces make unit testing easy

### Negative

1. **Initial complexity**: More moving parts than simple direct posting
2. **Provider stubs**: QuickBooks provider needs full SDK integration
3. **Storage dependency**: Requires persistent storage for production
4. **OAuth management**: Providers need token refresh handling

### Neutral

1. **Two documents per payout**: JE + Transfer is more than Deposit alone, but provides better detail
2. **Synchronous initially**: Ready for async but not required for MVP

## Implementation Notes

### Key Components

- `BaseAccountingProvider` - Abstract interface
- `QuickBooksProvider` - QBO implementation (stub)
- `PayoutSyncService` - Domain service with core logic
- `WebhookEventStore` - Event deduplication
- `SyncLedger` - Payout->document mapping
- `AccountingSyncConfig` - Configuration management

### Testing

All critical paths are tested:
- Balance transaction summarization
- Total validation
- Posting instructions generation
- Idempotency
- Drift detection

### Production Readiness

Before production deployment:
1. Replace in-memory storage with persistent storage
2. Implement async job queue (Azure Queue/Service Bus)
3. Add QuickBooks OAuth token management
4. Set up monitoring and alerts
5. Test with QBO sandbox environment

## Alternatives Considered

### Alternative 1: Direct posting without abstraction

**Rejected because**:
- Tight coupling to QuickBooks
- Difficult to add other providers
- Hard to test without real QBO connection

### Alternative 2: Single Deposit document

**Partially accepted** (available via configuration):
- Simpler but loses activity detail
- Available as `ACCOUNTING_POSTING_STRATEGY=deposit`

### Alternative 3: Per-transaction posting

**Deferred**:
- Much more granular but creates many documents
- Can be added as `ACCOUNTING_POSTING_GRANULARITY=per-transaction`
- Not default due to volume

### Alternative 4: No clearing account

**Rejected because**:
- Makes reconciliation harder
- Deviates from accounting best practices
- Net effect tracking is unclear

## References

- [Stripe Payouts API](https://stripe.com/docs/api/payouts)
- [QuickBooks Online API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry)
- [PAYOUT_SYNC_SETUP.md](../../PAYOUT_SYNC_SETUP.md) - Implementation documentation
- [tests/payoutSync.test.js](../../tests/payoutSync.test.js) - Test suite

## Date

2024-09-30

## Authors

- Payment Processor Development Team
