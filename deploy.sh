#!/bin/bash

# Azure Function Deployment Script
# This script automates the deployment of the payment processing function to Azure

set -e

# Configuration variables
RESOURCE_GROUP="payment-processing-rg"
FUNCTION_APP_NAME="payment-processing-function"
STORAGE_ACCOUNT_NAME="paymentprocessingstorage"
LOCATION="East US"

echo "🚀 Starting Azure Function deployment..."

# Check if Azure CLI is installed
if ! command -v az &> /dev/null; then
    echo "❌ Azure CLI is not installed. Please install it first."
    echo "   Visit: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
    exit 1
fi

# Check if user is logged in
if ! az account show &> /dev/null; then
    echo "🔐 Please login to Azure..."
    az login
fi

echo "📋 Current Azure subscription:"
az account show --query "{subscriptionId:id, name:name, user:user.name}" --output table

read -p "Continue with this subscription? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Deployment cancelled."
    exit 1
fi

# Create resource group
echo "📦 Creating resource group: $RESOURCE_GROUP"
az group create --name $RESOURCE_GROUP --location "$LOCATION" --output table

# Create storage account
echo "💾 Creating storage account: $STORAGE_ACCOUNT_NAME"
az storage account create \
  --name $STORAGE_ACCOUNT_NAME \
  --location "$LOCATION" \
  --resource-group $RESOURCE_GROUP \
  --sku Standard_LRS \
  --output table

# Create function app
echo "⚡ Creating function app: $FUNCTION_APP_NAME"
az functionapp create \
  --resource-group $RESOURCE_GROUP \
  --consumption-plan-location "$LOCATION" \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4 \
  --name $FUNCTION_APP_NAME \
  --storage-account $STORAGE_ACCOUNT_NAME \
  --os-type Linux \
  --output table

echo "🔧 Function app created successfully!"

# Get function app details
echo "📊 Function app details:"
az functionapp show --name $FUNCTION_APP_NAME --resource-group $RESOURCE_GROUP --query "{name:name, location:location, state:state, defaultHostName:defaultHostName}" --output table

echo ""
echo "✅ Deployment infrastructure is ready!"
echo ""
echo "Next steps:"
echo "1. Configure application settings:"
echo "   az functionapp config appsettings set --name $FUNCTION_APP_NAME --resource-group $RESOURCE_GROUP --settings 'STRIPE_TEST_SECRET_KEY=sk_test_YOUR_KEY_HERE'"
echo ""
echo "2. Deploy function code:"
echo "   func azure functionapp publish $FUNCTION_APP_NAME"
echo ""
echo "3. Your function URL will be:"
echo "   https://$FUNCTION_APP_NAME.azurewebsites.net/api/donation"
echo ""
echo "🎉 Deployment completed successfully!"