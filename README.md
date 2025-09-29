# Payment Processing Azure Function

This Azure Function app replicates the functionality of the Power Automate flow for processing donations through Stripe. It handles customer management, payment processing, and email notifications.

## Features

- **Payment Processing**: Handles both one-time and recurring donations
- **Customer Management**: Searches for existing Stripe customers and creates new ones when needed
- **Email Notifications**: Sends formatted notification emails for new donations
- **Error Handling**: Comprehensive error handling with appropriate HTTP responses
- **Validation**: Input validation for required fields

## Prerequisites

Before deploying this Azure Function, ensure you have:

1. **Azure Subscription**: An active Azure subscription
2. **Azure CLI**: Install from [here](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli)
3. **Azure Functions Core Tools**: Install from [here](https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local)
4. **Node.js**: Version 18.x or later
5. **Stripe Account**: With API keys (test and live)
6. **SendGrid Account**: For email notifications

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
    "NOTIFICATION_EMAIL_TEST": "micah@refugeintl.org",
    "NOTIFICATION_EMAIL_LIVE": "info@refugeintl.org",
    "SUCCESS_URL": "https://refugeintl.org/thankyou"
  }
}
```

### 3. Start Local Development

```bash
npm start
```

The function will be available at `http://localhost:7071/api/donation`

## Azure Deployment Guide

### Step 1: Login to Azure

```bash
az login
```

### Step 2: Create Resource Group

```bash
az group create --name payment-processing-rg --location "East US"
```

### Step 3: Create Storage Account

```bash
az storage account create \
  --name paymentprocessingstorage \
  --location "East US" \
  --resource-group payment-processing-rg \
  --sku Standard_LRS
```

### Step 4: Create Function App

```bash
az functionapp create \
  --resource-group payment-processing-rg \
  --consumption-plan-location "East US" \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4 \
  --name payment-processing-function \
  --storage-account paymentprocessingstorage \
  --os-type Linux
```

### Step 5: Configure Application Settings

```bash
# Stripe Configuration
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings \
  "STRIPE_TEST_SECRET_KEY=sk_test_YOUR_TEST_KEY_HERE" \
  "STRIPE_LIVE_SECRET_KEY=sk_live_YOUR_LIVE_KEY_HERE"

# SendGrid Configuration
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings \
  "SENDGRID_API_KEY=YOUR_SENDGRID_API_KEY_HERE"

# Email Configuration
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings \
  "NOTIFICATION_EMAIL_TEST=micah@refugeintl.org" \
  "NOTIFICATION_EMAIL_LIVE=info@refugeintl.org" \
  "SUCCESS_URL=https://refugeintl.org/thankyou"

# Deployment Configuration (Required for GitHub Actions)
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings \
  "WEBSITE_RUN_FROM_PACKAGE=1"
```

**Important:** The `WEBSITE_RUN_FROM_PACKAGE=1` setting is crucial for GitHub Actions deployment. Do not remove this setting as it will cause the function to stop appearing in the Azure Portal.

### Step 6: Deploy Function Code

```bash
func azure functionapp publish payment-processing-function
```

### Step 7: Test the Deployment

After deployment, test the function to ensure it's working correctly:

```bash
# Test with the provided test script
node test-deployment.js https://payment-processing-function.azurewebsites.net/api/donation YOUR_FUNCTION_KEY

# Or test locally during development
npm start
node test-deployment.js http://localhost:7071/api/donation
```

### Step 8: Configure CORS (Optional)

If you need to call this function from a web browser:

```bash
az functionapp cors add \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --allowed-origins "https://refugeintl.org" "https://www.refugeintl.org"
```

## API Usage

### Endpoint

```
POST https://payment-processing-function.azurewebsites.net/api/donation
```

### Headers

```
Content-Type: application/json
x-functions-key: YOUR_FUNCTION_KEY
```

### Request Body

```json
{
  "email": "donor@example.com",
  "firstname": "John",
  "lastname": "Doe",
  "phone": "+1234567890",
  "amount": 5000,
  "frequency": "month",
  "category": "General Donation",
  "coverFee": true,
  "livemode": false,
  "address": {
    "line1": "123 Main St",
    "line2": "Apt 4B",
    "city": "New York",
    "state": "NY",
    "postal_code": "10001",
    "country": "US"
  }
}
```

### Response

**Success (200)**:
```json
{
  "id": "cs_test_1234567890abcdef"
}
```

**Error (400)**:
```json
{
  "error": "Missing required fields: email, firstname"
}
```

**Error (500)**:
```json
{
  "error": "Failed to process payment. Please try again later."
}
```

## Configuration Details

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `STRIPE_TEST_SECRET_KEY` | Stripe test secret key | `sk_test_...` |
| `STRIPE_LIVE_SECRET_KEY` | Stripe live secret key | `sk_live_...` |
| `SENDGRID_API_KEY` | SendGrid API key for emails | `SG.xxx` |
| `NOTIFICATION_EMAIL_TEST` | Email for test notifications | `test@example.com` |
| `NOTIFICATION_EMAIL_LIVE` | Email for live notifications | `live@example.com` |
| `SUCCESS_URL` | Redirect URL after payment | `https://example.com/success` |

### Optional Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AzureWebJobsStorage` | Storage connection string | Required for Azure |

## Monitoring and Logging

### Application Insights

The function automatically logs to Application Insights if configured. Key metrics include:

- Request count and response times
- Error rates and exceptions
- Custom events for payment processing steps

### Accessing Logs

```bash
# View function logs
func azure functionapp logstream payment-processing-function

# Or use Azure CLI
az webapp log tail --name payment-processing-function --resource-group payment-processing-rg
```

## Security Considerations

1. **Function Keys**: Always use function-level authentication
2. **HTTPS Only**: Ensure all requests use HTTPS
3. **API Keys**: Store sensitive keys in Azure Key Vault for production
4. **CORS**: Configure CORS appropriately for your domain
5. **Input Validation**: The function validates all required inputs

## Troubleshooting

### Common Issues

1. **Function not starting**: Check that all required environment variables are set
2. **Stripe errors**: Verify API keys are correct and have proper permissions
3. **Email failures**: Ensure SendGrid API key is valid and sender is verified
4. **Function not visible in Azure Portal**: This usually means `WEBSITE_RUN_FROM_PACKAGE=1` is missing

### Function Not Appearing in Azure Portal

If your function disappears from the Azure Portal after deployment, it's likely because the `WEBSITE_RUN_FROM_PACKAGE` setting was removed. This setting is required for GitHub Actions deployment.

**Quick Fix:**
```bash
# Run the fix script
./fix-deployment.sh

# Or manually restore the setting
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings "WEBSITE_RUN_FROM_PACKAGE=1"

# Restart the function app
az functionapp restart \
  --name payment-processing-function \
  --resource-group payment-processing-rg
```

**Prevention:** Never delete the `WEBSITE_RUN_FROM_PACKAGE` setting when using GitHub Actions for deployment.
4. **CORS errors**: Add your domain to allowed origins

### Debugging

1. Enable Application Insights for detailed logging
2. Use `func start` locally with debug configuration
3. Check Azure Function logs in the portal
4. Test individual components (Stripe API, SendGrid) separately

## Cost Optimization

### Azure Functions Pricing

- **Consumption Plan**: Pay per execution (recommended for low-medium traffic)
- **Premium Plan**: Always-on instances with better performance
- **Dedicated Plan**: Fixed monthly cost with predictable pricing

### Recommendations

- Use Consumption Plan for cost-effective scaling
- Monitor execution count and duration
- Optimize cold start times with proper dependency management

## Support

For issues related to:
- **Azure Functions**: Check [Azure Functions documentation](https://docs.microsoft.com/en-us/azure/azure-functions/)
- **Stripe Integration**: Check [Stripe API documentation](https://stripe.com/docs/api)
- **SendGrid**: Check [SendGrid documentation](https://docs.sendgrid.com/)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.