#!/bin/bash

# Fix Azure Function Deployment Script
# This script fixes the deployment issue after WEBSITE_RUN_FROM_PACKAGE was removed

set -e

# Configuration variables
RESOURCE_GROUP="payment-processing-rg"
FUNCTION_APP_NAME="payment-processing-function"

echo "🔧 Fixing Azure Function deployment issue..."

# Check if Azure CLI is installed and user is logged in
if ! command -v az &> /dev/null; then
    echo "❌ Azure CLI is not installed. Please install it first."
    exit 1
fi

if ! az account show &> /dev/null; then
    echo "🔐 Please login to Azure first: az login"
    exit 1
fi

echo "📋 Current Azure subscription:"
az account show --query "{subscriptionId:id, name:name, user:user.name}" --output table

echo ""
echo "🔧 Restoring WEBSITE_RUN_FROM_PACKAGE setting for GitHub deployment..."

# Set the WEBSITE_RUN_FROM_PACKAGE setting to 1 for GitHub Actions deployment
az functionapp config appsettings set \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --settings \
  "WEBSITE_RUN_FROM_PACKAGE=1" \
  --output table

echo ""
echo "🔄 Restarting the function app to apply changes..."
az functionapp restart \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --output table

echo ""
echo "📊 Current function app status:"
az functionapp show \
  --name $FUNCTION_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query "{name:name, state:state, defaultHostName:defaultHostName, lastModifiedTimeUtc:lastModifiedTimeUtc}" \
  --output table

echo ""
echo "✅ Deployment fix completed successfully!"
echo ""
echo "📝 What was fixed:"
echo "   - Restored WEBSITE_RUN_FROM_PACKAGE=1 setting"
echo "   - This enables proper GitHub Actions deployment"
echo "   - Function should now appear in Azure Portal"
echo ""
echo "🔄 Next steps:"
echo "1. Wait 2-3 minutes for the function app to fully restart"
echo "2. Check Azure Portal to confirm function is visible"
echo "3. Test the function endpoint:"
echo "   https://$FUNCTION_APP_NAME.azurewebsites.net/api/donation"
echo ""
echo "💡 If the function still doesn't appear, try triggering a GitHub Actions deployment:"
echo "   - Go to your GitHub repository"
echo "   - Navigate to the Actions tab"  
echo "   - Manually run the deployment workflow"
echo ""
echo "🎉 Function deployment should now be working properly!"