# Payment Processing Azure Function

This Azure Function app processes donations through Stripe, handling customer management, payment processing, and email notifications.

## Features

- Stripe payment processing (one-time and recurring donations)
- Customer management (search/create)
- Email notifications via SendGrid
- Support for both test and live modes

## Prerequisites

- Azure subscription
- Azure Functions Core Tools
- Node.js 18+
- Stripe account (test and live keys)
- SendGrid account for email notifications

## Local Development Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the `local.settings.json.template` to `local.settings.json` and fill in your values:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "STRIPE_TEST_SECRET_KEY": "sk_test_YOUR_TEST_KEY_HERE",
    "STRIPE_LIVE_SECRET_KEY": "sk_live_YOUR_LIVE_KEY_HERE",
    "SENDGRID_API_KEY": "YOUR_SENDGRID_API_KEY_HERE",
    "NOTIFICATION_EMAIL_TEST": "test@example.com",
    "NOTIFICATION_EMAIL_LIVE": "live@example.com",
    "SUCCESS_URL": "https://example.com/thankyou"
  }
}
```

### 3. Start Local Development

```bash
npm start
```

The function will be available at `http://localhost:7071/api/donation`

## Azure Deployment

### Automatic Deployment via GitHub Actions

This repository is configured for automatic deployment to Azure Functions via GitHub Actions. Push to the `main` branch to trigger deployment.

### Manual Deployment

```bash
func azure functionapp publish payment-processing-function
```

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `STRIPE_TEST_SECRET_KEY` | Stripe test secret key | `sk_test_...` |
| `STRIPE_LIVE_SECRET_KEY` | Stripe live secret key | `sk_live_...` |
| `SENDGRID_API_KEY` | SendGrid API key for emails | `SG.xxx` |
| `NOTIFICATION_EMAIL_TEST` | Email for test notifications | `test@example.com` |
| `NOTIFICATION_EMAIL_LIVE` | Email for live notifications | `live@example.com` |
| `SUCCESS_URL` | Redirect URL after payment | `https://example.com/success` |

## API Usage

### Endpoint

```
POST /api/donation
```

### Request Body

```json
{
  "email": "donor@example.com",
  "firstname": "John",
  "lastname": "Doe",
  "phone": "+1234567890",
  "amount": 2500,
  "frequency": "onetime",
  "category": "General Donation",
  "coverFee": false,
  "livemode": false,
  "address": {
    "line1": "123 Main St",
    "city": "New York",
    "state": "NY",
    "postal_code": "10001",
    "country": "US"
  }
}
```

### Response

```json
{
  "id": "cs_test_checkout_session_id"
}
```

## License

MIT License