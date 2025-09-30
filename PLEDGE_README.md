# Pledges Feature

## Overview

The Pledges feature allows creation and management of pledges (commitments to give a total amount over time), with installment schedules, automated payment matching, and full CRM integration.

## Key Features

- ✅ **Pledge Lifecycle Management**: Create, update, write-off, and cancel pledges
- ✅ **Installment Scheduling**: Automatically generate monthly, quarterly, or custom payment schedules
- ✅ **Automated Payment Matching**: Confidence-based matching of transactions to pledges
- ✅ **FIFO Allocation**: Payments automatically allocated to earliest unpaid installments
- ✅ **Review Workflow**: Low-confidence matches create review tasks for manual resolution
- ✅ **CRM Integration**: Full Salesforce integration with dedicated pledge objects
- ✅ **Flexible Policies**: Configurable prepayment, overpayment, and matching policies

## Architecture

The Pledges feature uses **new CRM objects** (Option A as per ADR 001):
- **Pledge__c**: Master pledge record
- **PledgeInstallment__c**: Individual installment schedules
- **PledgePaymentAllocation__c**: Junction linking transactions to installments
- **Transaction__c**: Extended with optional pledge reference

See [ADR 001](./docs/adr/001-pledge-crm-integration.md) for detailed rationale.

## Quick Start

### 1. Salesforce Setup

Follow the [Salesforce Pledge Setup Guide](./docs/SALESFORCE_PLEDGE_SETUP.md) to create the required custom objects.

### 2. Enable Pledge Feature

The pledge feature is enabled by default. To disable it:

```bash
PLEDGE_FEATURE_ENABLED=false
```

### 3. Configure Matching

Set matching thresholds and weights via environment variables:

```bash
# Decision thresholds
PLEDGE_MATCH_THRESHOLD_HIGH=0.90  # Auto-apply above this
PLEDGE_MATCH_THRESHOLD_LOW=0.60   # Review required between LOW and HIGH

# Matching weights
PLEDGE_MATCH_WEIGHT_EXPLICIT_ID=0.8    # Explicit pledge_id in metadata
PLEDGE_MATCH_WEIGHT_CATEGORY=0.3       # Category/fund alignment
PLEDGE_MATCH_WEIGHT_DUE_DATE=0.3       # Due date proximity
PLEDGE_MATCH_WEIGHT_AMOUNT=0.3         # Amount fit vs balance
PLEDGE_MATCH_WEIGHT_MEMO=0.2           # Memo pattern match
PLEDGE_MATCH_WEIGHT_PRIOR_LINK=0.2     # Historical linkage

# Matching tolerances
PLEDGE_DUE_DATE_WINDOW_DAYS=7          # +/- days for due date matching
PLEDGE_AMOUNT_TOLERANCE_PERCENT=5.0    # % tolerance for amount matching
```

### 4. Configure Prepayment Policy

```bash
PLEDGE_PREPAYMENT_POLICY=balance_only  # or 'prepay_future'
PLEDGE_ALLOW_OVERPAYMENT=true          # Excess becomes non-pledge payment
PLEDGE_MAX_PREPAY_INSTALLMENTS=12      # Max installments to prepay
```

## API Endpoints

### Create Pledge

```bash
POST /api/pledges
Authorization: function key

{
  "contactId": "0031234567890ABC",
  "fundCategory": "Building Fund",
  "totalAmount": 12000,
  "currency": "USD",
  "startDate": "2025-02-01",
  "scheduleType": "Monthly",
  "numberOfInstallments": 12,
  "notes": "Annual pledge"
}
```

**Response:**
```json
{
  "success": true,
  "pledge": {
    "Id": "PLG000001",
    "contactId": "0031234567890ABC",
    "fundCategory": "Building Fund",
    "totalAmount": 12000,
    "balanceRemaining": 12000,
    "status": "Active"
  },
  "installments": [
    {
      "Id": "INST000001",
      "sequenceNumber": 1,
      "dueDate": "2025-02-01",
      "amountDue": 1000,
      "status": "Unpaid"
    }
    // ... 11 more installments
  ]
}
```

### Get Pledge

```bash
GET /api/pledges/{pledgeId}
Authorization: function key
```

**Response:**
```json
{
  "success": true,
  "pledge": {
    "Id": "PLG000001",
    "fundCategory": "Building Fund",
    "totalAmount": 12000,
    "balanceRemaining": 10000,
    "status": "Active",
    "installments": [...]
  },
  "summary": {
    "totalPaid": 2000,
    "percentPaid": 16.67,
    "paidInstallments": 2,
    "overdueInstallments": 0,
    "nextDueDate": "2025-04-01",
    "nextDueAmount": 1000
  }
}
```

### Update Pledge

```bash
PATCH /api/pledges/{pledgeId}
Authorization: function key

{
  "notes": "Updated notes",
  "status": "Paused"
}
```

### Write Off Pledge

```bash
POST /api/pledges/{pledgeId}/write-off
Authorization: function key

{
  "reason": "Donor relocated"
}
```

### Manual Allocation

```bash
POST /api/transactions/{transactionId}/apply-to-pledge
Authorization: function key

{
  "pledgeId": "PLG000001",
  "appliedBy": "user@example.com"
}
```

## Automated Payment Matching

When a payment is processed via Stripe webhook:

1. **Contact Matching**: Transaction is matched to a contact (existing flow)
2. **Pledge Candidate Selection**: Get all active pledges for the contact
3. **Scoring**: Score each pledge based on signals:
   - Explicit pledge_id in transaction metadata
   - Category/fund alignment
   - Due date proximity
   - Amount fit vs remaining balance
   - Memo pattern match (e.g., "Pledge #1234")
   - Historical linkage (same payment method)
4. **Decision**:
   - **High confidence (≥ 0.90)**: Auto-apply to pledge
   - **Medium confidence (0.60-0.89)**: Create review task
   - **Low confidence (< 0.60)**: Process as regular transaction, create review task

### Explicit Pledge Linking

To guarantee a transaction is applied to a specific pledge, include the pledge ID in the Stripe payment metadata:

```javascript
const paymentIntent = await stripe.paymentIntents.create({
  amount: 100000, // $1000
  currency: 'usd',
  customer: 'cus_123',
  metadata: {
    pledgeId: 'PLG000001' // Salesforce Pledge ID
  }
});
```

This gives a confidence score of 0.8, which combined with other signals will typically result in auto-apply.

## Payment Allocation

### FIFO (First-In-First-Out)

Payments are applied to the earliest unpaid/partial installment first:

```
Pledge: $1200 / 12 months = $100/month

Payment $250:
  - $100 → Installment 1 (paid)
  - $100 → Installment 2 (paid)
  - $50  → Installment 3 (partial)
```

### Overpayment

**Default Policy (balance_only)**:
- Payment applies only up to remaining pledge balance
- Excess becomes a regular (non-pledge) transaction or credit

**Alternative (prepay_future)**:
- Payment can prepay future installments
- Still respects total pledge amount

### Underpayment

- Installment marked as "Partial"
- Next payment continues from partially paid installment

## Review Workflow

For uncertain matches, a review task is created in the CRM with:

- Transaction details (amount, date, method, memo)
- Candidate pledges with scores and matching signals
- Pledge summaries (fund, balance, next due date)
- Decision context (thresholds, confidence score)
- Deep links to CRM records

Reviewers can then use the manual allocation endpoint to apply the payment to the correct pledge.

## Configuration Reference

### Matching Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PLEDGE_MATCH_THRESHOLD_HIGH` | Auto-apply threshold | 0.90 |
| `PLEDGE_MATCH_THRESHOLD_LOW` | Review required threshold | 0.60 |
| `PLEDGE_MATCH_WEIGHT_EXPLICIT_ID` | Weight for explicit pledge_id | 0.8 |
| `PLEDGE_MATCH_WEIGHT_CATEGORY` | Weight for category match | 0.3 |
| `PLEDGE_MATCH_WEIGHT_DUE_DATE` | Weight for due date proximity | 0.3 |
| `PLEDGE_MATCH_WEIGHT_AMOUNT` | Weight for amount fit | 0.3 |
| `PLEDGE_MATCH_WEIGHT_MEMO` | Weight for memo pattern | 0.2 |
| `PLEDGE_MATCH_WEIGHT_PRIOR_LINK` | Weight for prior linkage | 0.2 |

### Schedule Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PLEDGE_DEFAULT_SCHEDULE_TYPE` | Default schedule type | monthly |
| `PLEDGE_DEFAULT_START_DAY` | Default day of month | 1 |
| `PLEDGE_ALLOW_PAST_START_DATE` | Allow past start dates | false |
| `PLEDGE_MAX_INSTALLMENTS` | Max installments allowed | 120 |

### Prepayment Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PLEDGE_PREPAYMENT_POLICY` | Policy: balance_only or prepay_future | balance_only |
| `PLEDGE_ALLOW_OVERPAYMENT` | Allow overpayment | true |
| `PLEDGE_MAX_PREPAY_INSTALLMENTS` | Max installments to prepay | 12 |

### Validation Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PLEDGE_MIN_TOTAL_AMOUNT` | Minimum pledge amount | 1.00 |
| `PLEDGE_MAX_TOTAL_AMOUNT` | Maximum pledge amount | 1000000.00 |
| `PLEDGE_MIN_INSTALLMENTS` | Minimum installments | 1 |
| `PLEDGE_ALLOWED_CURRENCIES` | Allowed currencies (comma-separated) | USD,EUR,GBP,CAD |

## Observability

### Logging

Structured logs are emitted for all pledge operations:

```json
{
  "timestamp": "2025-01-15T12:00:00Z",
  "operation": "pledge_allocation",
  "pledgeId": "PLG000001",
  "transactionId": "TXN123",
  "decision": "auto_apply",
  "confidence": 0.95,
  "allocations": 2,
  "pledgeBalance": 10000
}
```

### Redaction

PII/PCI data is redacted in logs when `PLEDGE_REDACT_PII=true` (default):
- Card numbers → last 4 only
- Email → masked
- Phone → masked
- Amounts → [REDACTED] in some contexts

## Testing

Run pledge tests:

```bash
node tests/pledge.test.js
```

Tests cover:
- ✅ Schedule generation (monthly/quarterly/custom)
- ✅ Installment amount calculation with proper rounding
- ✅ FIFO allocation (exact, split, over/underpayment)
- ✅ Prepayment policies
- ✅ Write-off and cancellation
- ✅ Backward compatibility (all existing tests pass)

## Migration

The pledge feature is **backward compatible**:
- Existing transactions continue to work
- No changes to existing transaction reports
- Pledge fields on Transaction__c are optional
- Feature can be disabled via `PLEDGE_FEATURE_ENABLED=false`

## Troubleshooting

### Pledges not auto-allocating

1. Check pledge feature is enabled: `PLEDGE_FEATURE_ENABLED=true`
2. Verify contact has active pledges
3. Check matching confidence score in logs
4. Review matching weights and thresholds

### Duplicate allocations

Idempotency is enforced via:
- Unique constraint on (Transaction__c, PledgeInstallment__c)
- Same transaction cannot be allocated to same installment twice

### CRM errors

1. Verify Salesforce objects are created (see setup guide)
2. Check API user has required permissions
3. Review CRM connection logs

## Support

- [ADR 001: Pledge CRM Integration](./docs/adr/001-pledge-crm-integration.md)
- [Salesforce Setup Guide](./docs/SALESFORCE_PLEDGE_SETUP.md)
- [Main README](./README.md)
