# Azure Function Deployment Guide

This guide provides multiple deployment methods for the Payment Processing Azure Function, from automated scripts to manual Azure Portal deployment.

## Quick Start (Recommended)

### Option 1: Automated Script Deployment

```bash
# 1. Run the deployment script
./deploy.sh

# 2. Configure app settings
./configure-app-settings.sh

# 3. Deploy function code (requires Azure Functions Core Tools)
func azure functionapp publish payment-processing-function
```

## Detailed Deployment Methods

### Method 1: Azure CLI (Command Line)

#### Prerequisites
- Azure CLI installed
- Azure Functions Core Tools installed
- Active Azure subscription

#### Step-by-Step Commands

```bash
# 1. Login to Azure
az login

# 2. Create resource group
az group create --name payment-processing-rg --location "East US"

# 3. Create storage account
az storage account create \
  --name paymentprocessingstorage \
  --location "East US" \
  --resource-group payment-processing-rg \
  --sku Standard_LRS

# 4. Create function app
az functionapp create \
  --resource-group payment-processing-rg \
  --consumption-plan-location "East US" \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4 \
  --name payment-processing-function \
  --storage-account paymentprocessingstorage \
  --os-type Linux

# 5. Configure application settings
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings \
  "STRIPE_TEST_SECRET_KEY=sk_test_YOUR_TEST_KEY_HERE" \
  "STRIPE_LIVE_SECRET_KEY=sk_live_YOUR_LIVE_KEY_HERE" \
  "SENDGRID_API_KEY=YOUR_SENDGRID_API_KEY_HERE" \
  "NOTIFICATION_EMAIL_TEST=micah@refugeintl.org" \
  "NOTIFICATION_EMAIL_LIVE=info@refugeintl.org" \
  "SUCCESS_URL=https://refugeintl.org/thankyou"

# 6. Deploy function code
func azure functionapp publish payment-processing-function
```

### Method 2: Azure Portal (Web Interface)

#### Step 1: Create Function App
1. Go to [Azure Portal](https://portal.azure.com)
2. Click "Create a resource"
3. Search for "Function App"
4. Fill in the details:
   - **Subscription**: Your Azure subscription
   - **Resource Group**: Create new "payment-processing-rg"
   - **Function App name**: "payment-processing-function"
   - **Runtime stack**: Node.js
   - **Version**: 18 LTS
   - **Region**: East US
   - **Plan type**: Consumption (Serverless)

#### Step 2: Configure App Settings
1. Go to your Function App in the portal
2. Navigate to "Configuration" under Settings
3. Add the following Application settings:
   - `STRIPE_TEST_SECRET_KEY`: Your Stripe test key
   - `STRIPE_LIVE_SECRET_KEY`: Your Stripe live key
   - `SENDGRID_API_KEY`: Your SendGrid API key
   - `NOTIFICATION_EMAIL_TEST`: micah@refugeintl.org
   - `NOTIFICATION_EMAIL_LIVE`: info@refugeintl.org
   - `SUCCESS_URL`: https://refugeintl.org/thankyou

#### Step 3: Deploy Code
**Option A: ZIP Deployment**
1. Create a ZIP file of the function code
2. Go to "Deployment Center" in your Function App
3. Choose "ZIP Deploy" and upload your ZIP file

**Option B: GitHub Actions**
1. Connect your GitHub repository
2. Configure GitHub Actions for automatic deployment

### Method 3: Visual Studio Code

#### Prerequisites
- Visual Studio Code
- Azure Functions extension
- Azure Account extension

#### Steps
1. Install the Azure Functions extension
2. Sign in to your Azure account
3. Create a new Function App from VS Code
4. Deploy using the Azure Functions extension

### Method 4: ARM Template Deployment

#### Azure Resource Manager Template

Create `azuredeploy.json`:

```json
{
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {
        "functionAppName": {
            "type": "string",
            "defaultValue": "payment-processing-function"
        },
        "storageAccountName": {
            "type": "string",
            "defaultValue": "paymentprocessingstorage"
        }
    },
    "variables": {
        "hostingPlanName": "[concat(parameters('functionAppName'), '-plan')]"
    },
    "resources": [
        {
            "type": "Microsoft.Storage/storageAccounts",
            "apiVersion": "2019-06-01",
            "name": "[parameters('storageAccountName')]",
            "location": "[resourceGroup().location]",
            "sku": {
                "name": "Standard_LRS"
            },
            "kind": "Storage"
        },
        {
            "type": "Microsoft.Web/serverfarms",
            "apiVersion": "2020-06-01",
            "name": "[variables('hostingPlanName')]",
            "location": "[resourceGroup().location]",
            "sku": {
                "name": "Y1",
                "tier": "Dynamic"
            }
        },
        {
            "type": "Microsoft.Web/sites",
            "apiVersion": "2020-06-01",
            "name": "[parameters('functionAppName')]",
            "location": "[resourceGroup().location]",
            "kind": "functionapp,linux",
            "dependsOn": [
                "[resourceId('Microsoft.Web/serverfarms', variables('hostingPlanName'))]",
                "[resourceId('Microsoft.Storage/storageAccounts', parameters('storageAccountName'))]"
            ],
            "properties": {
                "serverFarmId": "[resourceId('Microsoft.Web/serverfarms', variables('hostingPlanName'))]",
                "siteConfig": {
                    "appSettings": [
                        {
                            "name": "AzureWebJobsStorage",
                            "value": "[concat('DefaultEndpointsProtocol=https;AccountName=', parameters('storageAccountName'), ';EndpointSuffix=', environment().suffixes.storage, ';AccountKey=',listKeys(resourceId('Microsoft.Storage/storageAccounts', parameters('storageAccountName')), '2019-06-01').keys[0].value)]"
                        },
                        {
                            "name": "FUNCTIONS_EXTENSION_VERSION",
                            "value": "~4"
                        },
                        {
                            "name": "FUNCTIONS_WORKER_RUNTIME",
                            "value": "node"
                        }
                    ],
                    "linuxFxVersion": "Node|18"
                }
            }
        }
    ]
}
```

Deploy with:
```bash
az deployment group create \
  --resource-group payment-processing-rg \
  --template-file azuredeploy.json
```

## Post-Deployment Configuration

### 1. Get Function Keys
```bash
# Get the default function key
az functionapp keys list --name payment-processing-function --resource-group payment-processing-rg
```

### 2. Test the Function
```bash
# Test endpoint
curl -X POST https://payment-processing-function.azurewebsites.net/api/donation \
  -H "Content-Type: application/json" \
  -H "x-functions-key: YOUR_FUNCTION_KEY" \
  -d '{
    "email": "test@example.com",
    "firstname": "John",
    "lastname": "Doe",
    "amount": 5000,
    "frequency": "onetime",
    "livemode": false
  }'
```

### 3. Monitor the Function
```bash
# View logs
az webapp log tail --name payment-processing-function --resource-group payment-processing-rg

# View metrics in Azure Portal
# Navigate to your Function App > Monitor > Metrics
```

## Security Configuration

### 1. Use Azure Key Vault (Recommended for Production)

```bash
# Create Key Vault
az keyvault create \
  --name payment-processing-kv \
  --resource-group payment-processing-rg \
  --location "East US"

# Add secrets
az keyvault secret set --vault-name payment-processing-kv --name "StripeTestKey" --value "sk_test_..."
az keyvault secret set --vault-name payment-processing-kv --name "StripeLiveKey" --value "sk_live_..."
az keyvault secret set --vault-name payment-processing-kv --name "SendGridKey" --value "SG..."

# Configure Function App to use Key Vault
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings \
  "STRIPE_TEST_SECRET_KEY=@Microsoft.KeyVault(VaultName=payment-processing-kv;SecretName=StripeTestKey)" \
  "STRIPE_LIVE_SECRET_KEY=@Microsoft.KeyVault(VaultName=payment-processing-kv;SecretName=StripeLiveKey)" \
  "SENDGRID_API_KEY=@Microsoft.KeyVault(VaultName=payment-processing-kv;SecretName=SendGridKey)"
```

### 2. Configure CORS

```bash
az functionapp cors add \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --allowed-origins "https://refugeintl.org" "https://www.refugeintl.org"
```

### 3. Enable HTTPS Only

```bash
az functionapp update \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --set httpsOnly=true
```

## Monitoring and Logging

### 1. Enable Application Insights

```bash
# Create Application Insights
az monitor app-insights component create \
  --app payment-processing-insights \
  --location "East US" \
  --resource-group payment-processing-rg

# Get instrumentation key
INSTRUMENTATION_KEY=$(az monitor app-insights component show \
  --app payment-processing-insights \
  --resource-group payment-processing-rg \
  --query instrumentationKey -o tsv)

# Configure Function App
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group payment-processing-rg \
  --settings "APPINSIGHTS_INSTRUMENTATIONKEY=$INSTRUMENTATION_KEY"
```

### 2. Set up Alerts

Create alerts for:
- Function execution failures
- High response times
- Error rates

## Troubleshooting

### Common Issues

1. **Function app not starting**
   - Check application settings
   - Verify storage account connection
   - Check runtime version compatibility

2. **Module not found errors**
   - Ensure all dependencies are in package.json
   - Verify Node.js version compatibility

3. **Stripe API errors**
   - Verify API keys are correct
   - Check API key permissions
   - Ensure test/live mode matches

4. **Email delivery issues**
   - Verify SendGrid API key
   - Check sender verification
   - Review SendGrid activity logs

5. **Function not visible in Azure Portal**
   - This usually indicates `WEBSITE_RUN_FROM_PACKAGE=1` setting is missing
   - Run `./fix-deployment.sh` to restore the setting
   - Never delete `WEBSITE_RUN_FROM_PACKAGE` when using GitHub Actions deployment

### Fix Function Visibility Issue

If your function disappears from Azure Portal after running:
```bash
az functionapp config appsettings delete --name payment-processing-function --resource-group payment-processing-rg --setting-names WEBSITE_RUN_FROM_PACKAGE
```

**Solution:**
```bash
# Use the provided fix script
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

### Diagnostic Commands

```bash
# Check function app status
az functionapp show --name payment-processing-function --resource-group payment-processing-rg --query state

# View deployment logs
az webapp deployment log list --name payment-processing-function --resource-group payment-processing-rg

# Stream live logs
az webapp log tail --name payment-processing-function --resource-group payment-processing-rg
```

## Cost Optimization

### Consumption Plan Benefits
- Pay only for executions
- Automatic scaling
- No idle costs

### Monitoring Costs
```bash
# View cost analysis
az consumption usage list --start-date 2024-01-01 --end-date 2024-01-31
```

## Cleanup

To remove all resources:

```bash
az group delete --name payment-processing-rg --yes --no-wait
```

This will delete all resources in the resource group including the Function App, Storage Account, and any other associated resources.