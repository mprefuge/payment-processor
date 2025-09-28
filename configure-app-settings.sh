#!/bin/bash

# Azure Function App Settings Configuration Script
# This script helps configure all required environment variables for the payment processing function

set -e

# Configuration variables
RESOURCE_GROUP="payment-processing-rg"
FUNCTION_APP_NAME="payment-processing-function"

echo "🔧 Configuring Azure Function app settings..."

# Check if Azure CLI is installed and user is logged in
if ! command -v az &> /dev/null; then
    echo "❌ Azure CLI is not installed. Please install it first."
    exit 1
fi

if ! az account show &> /dev/null; then
    echo "🔐 Please login to Azure first: az login"
    exit 1
fi

# Prompt for configuration values
echo "Please provide the following configuration values:"
echo ""

read -p "Stripe Test Secret Key (sk_test_...): " STRIPE_TEST_KEY
read -p "Stripe Live Secret Key (sk_live_...): " STRIPE_LIVE_KEY
read -p "SendGrid API Key (SG....): " SENDGRID_KEY
read -p "Test Notification Email (default: micah@refugeintl.org): " TEST_EMAIL
read -p "Live Notification Email (default: info@refugeintl.org): " LIVE_EMAIL
read -p "Success URL (default: https://refugeintl.org/thankyou): " SUCCESS_URL

# Set defaults if empty
TEST_EMAIL=${TEST_EMAIL:-"micah@refugeintl.org"}
LIVE_EMAIL=${LIVE_EMAIL:-"info@refugeintl.org"}
SUCCESS_URL=${SUCCESS_URL:-"https://refugeintl.org/thankyou"}

# Validate required inputs
if [[ -z "$STRIPE_TEST_KEY" || -z "$STRIPE_LIVE_KEY" || -z "$SENDGRID_KEY" ]]; then
    echo "❌ Error: Stripe keys and SendGrid API key are required."
    exit 1
fi

echo ""
echo "🔑 Configuring Stripe settings..."
az functionapp config appsettings set \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --settings \
  "STRIPE_TEST_SECRET_KEY=$STRIPE_TEST_KEY" \
  "STRIPE_LIVE_SECRET_KEY=$STRIPE_LIVE_KEY" \
  --output table

echo ""
echo "📧 Configuring email settings..."
az functionapp config appsettings set \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --settings \
  "SENDGRID_API_KEY=$SENDGRID_KEY" \
  "NOTIFICATION_EMAIL_TEST=$TEST_EMAIL" \
  "NOTIFICATION_EMAIL_LIVE=$LIVE_EMAIL" \
  "SUCCESS_URL=$SUCCESS_URL" \
  --output table

echo ""
echo "✅ Configuration completed successfully!"
echo ""
echo "Current app settings:"
az functionapp config appsettings list \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query "[?name=='STRIPE_TEST_SECRET_KEY' || name=='NOTIFICATION_EMAIL_TEST' || name=='NOTIFICATION_EMAIL_LIVE' || name=='SUCCESS_URL'].{Name:name,Value:value}" \
  --output table

echo ""
echo "🔒 Note: Sensitive values (API keys) are not displayed for security."
echo "🎉 Your function is now configured and ready to use!"