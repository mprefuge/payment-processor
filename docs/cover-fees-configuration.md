# Cover Fees Configuration

## Overview

The payment processor now supports flexible cover fee calculation to allow donors to cover processing fees. The system supports multiple fee structures based on nonprofit status and payment methods.

## Environment Variables

### `STRIPE_NONPROFIT_RATES`

Set this environment variable to enable nonprofit fee rates (discounted Stripe rates for eligible nonprofits).

```bash
STRIPE_NONPROFIT_RATES=true   # Enable nonprofit rates
STRIPE_NONPROFIT_RATES=false  # Use standard business rates (default)
```

## API Request Parameters

### Required Parameters (for cover fees)

- **`coverFee`** (boolean, optional): When `true`, processing fees will be added to the transaction total
  - Default: `false`

### Optional Parameters

- **`feeAmount`** (number, optional): Manually specify the fee amount in cents
  - When provided, this exact amount will be used instead of calculating fees
  - Must be a non-negative integer
  - Example: `200` = $2.00

- **`paymentMethod`** (string, optional): Specify the payment method to calculate appropriate fees
  - Allowed values: `'card'`, `'card_present'`, `'us_bank_account'`, `'amex'`
  - Default: `'card'`

## Fee Structures

### Standard Business Rates (`STRIPE_NONPROFIT_RATES=false` or not set)

| Payment Method | Fee Structure |
|----------------|---------------|
| `card` (online card) | 2.9% + $0.30 |
| `card_present` (in-person) | 2.7% + $0.05 |
| `us_bank_account` | 2.9% + $0.30 |
| `amex` | 2.9% + $0.30 |

### Nonprofit Rates (`STRIPE_NONPROFIT_RATES=true`)

| Payment Method | Fee Structure | Notes |
|----------------|---------------|-------|
| `card` (regular card) | 2.2% + $0.30 | Discounted nonprofit rate |
| `amex` (American Express) | 3.5% | No fixed fee |
| `us_bank_account` (ACH) | 0.8% | Capped at $5.00 |
| `card_present` (in-person) | 2.7% + $0.05 | Same as standard |

## Examples

### Example 1: Standard Card Payment with Cover Fees

```json
{
  "amount": 5000,
  "frequency": "onetime",
  "customer": {
    "email": "donor@example.com",
    "firstName": "John",
    "lastName": "Doe"
  },
  "coverFee": true
}
```

**Result:**
- Base amount: $50.00
- Calculated fee: 2.9% + $0.30 = $1.75
- Total charged: $51.75

### Example 2: Nonprofit Card Payment

Environment: `STRIPE_NONPROFIT_RATES=true`

```json
{
  "amount": 5000,
  "frequency": "onetime",
  "customer": {
    "email": "donor@example.com",
    "firstName": "Jane",
    "lastName": "Smith"
  },
  "coverFee": true,
  "paymentMethod": "card"
}
```

**Result:**
- Base amount: $50.00
- Calculated fee: 2.2% + $0.30 = $1.40
- Total charged: $51.40

### Example 3: ACH Payment with Nonprofit Rates

Environment: `STRIPE_NONPROFIT_RATES=true`

```json
{
  "amount": 100000,
  "frequency": "onetime",
  "customer": {
    "email": "donor@example.com",
    "firstName": "Major",
    "lastName": "Donor"
  },
  "coverFee": true,
  "paymentMethod": "us_bank_account"
}
```

**Result:**
- Base amount: $1,000.00
- Calculated fee: 0.8% = $8.00, but **capped at $5.00**
- Total charged: $1,005.00

### Example 4: Custom Fee Amount

```json
{
  "amount": 5000,
  "frequency": "onetime",
  "customer": {
    "email": "donor@example.com",
    "firstName": "Custom",
    "lastName": "Fee"
  },
  "coverFee": true,
  "feeAmount": 250
}
```

**Result:**
- Base amount: $50.00
- Custom fee: $2.50 (as specified)
- Total charged: $52.50

### Example 5: In-Person Card Payment

```json
{
  "amount": 5000,
  "frequency": "onetime",
  "customer": {
    "email": "donor@example.com",
    "firstName": "In",
    "lastName": "Person"
  },
  "coverFee": true,
  "paymentMethod": "card_present"
}
```

**Result:**
- Base amount: $50.00
- Calculated fee: 2.7% + $0.05 = $1.40
- Total charged: $51.40

## QuickBooks Integration

When cover fees are enabled, the system automatically:

1. **Creates two line items** in the QuickBooks Sales Receipt:
   - Base donation amount
   - Processing fee coverage (labeled "Processing Fee Coverage")

2. **Stores metadata** in the Stripe checkout session:
   - `cover_fees`: "true"
   - `cover_fees_amount`: Fee amount in cents (as string)

3. **Passes through to QBO** via the webhook processing:
   - The QBO service reads the metadata from the Stripe charge
   - Splits the total into appropriate line items

## Priority Order

The system determines which fee to use in this order:

1. **`feeAmount`** (if provided) - Always takes priority
2. **Calculated fee** (based on `paymentMethod` and `STRIPE_NONPROFIT_RATES`)
3. **No fee** (if `coverFee` is `false` or not provided)

## Testing

Run the cover fees test suite:

```bash
npm test -- coverFees.test.js
```

This test suite covers:
- Standard business rates
- Nonprofit rates
- Custom fee amounts
- Different payment methods
- ACH fee caps
- Amex rates

## Deployment Checklist

When deploying with nonprofit rates:

1. Set the environment variable:
   ```bash
   STRIPE_NONPROFIT_RATES=true
   ```

2. Verify your Stripe account is eligible for nonprofit rates

3. Test with small transactions first

4. Monitor the logs to ensure correct fee calculations:
   ```
   Cover fees enabled: calculated fee for card (nonprofit rates): 
   base amount 5000 cents, cover fees 140 cents, total 5140 cents
   ```
