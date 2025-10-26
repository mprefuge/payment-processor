# Test Script for Payout Feature
# This script demonstrates how to test the payout webhook locally

param(
    [string]$EventFile = ".\docs\examples\payout-paid-event.json",
    [string]$WebhookUrl = "http://localhost:7071/api/stripeWebhook"
)

Write-Host "=== Stripe Payout Webhook Test Script ===" -ForegroundColor Cyan
Write-Host ""

# Check if event file exists
if (-not (Test-Path $EventFile)) {
    Write-Host "Error: Event file not found: $EventFile" -ForegroundColor Red
    Write-Host "Available example files:" -ForegroundColor Yellow
    Get-ChildItem ".\docs\examples\payout-*.json" | ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 1
}

Write-Host "Event File: $EventFile" -ForegroundColor Green
Write-Host "Webhook URL: $WebhookUrl" -ForegroundColor Green
Write-Host ""

# Read the event JSON
$eventJson = Get-Content $EventFile -Raw
$event = $eventJson | ConvertFrom-Json

Write-Host "Event Details:" -ForegroundColor Cyan
Write-Host "  Event ID: $($event.id)"
Write-Host "  Event Type: $($event.type)"
Write-Host "  Payout ID: $($event.data.object.id)"
Write-Host "  Payout Amount: `$$($event.data.object.amount / 100)"
Write-Host "  Payout Status: $($event.data.object.status)"
Write-Host "  Currency: $($event.data.object.currency.ToUpper())"
Write-Host ""

# Check if local function is running
Write-Host "Checking if Azure Function is running..." -ForegroundColor Cyan
try {
    $response = Invoke-WebRequest -Uri "http://localhost:7071" -Method GET -TimeoutSec 2 -ErrorAction SilentlyContinue
    Write-Host "✓ Function app is running" -ForegroundColor Green
} catch {
    Write-Host "✗ Function app is NOT running" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please start the function app first:" -ForegroundColor Yellow
    Write-Host "  npm start" -ForegroundColor White
    Write-Host ""
    Write-Host "Or use Stripe CLI to forward webhooks:" -ForegroundColor Yellow
    Write-Host "  stripe listen --forward-to http://localhost:7071/api/stripeWebhook" -ForegroundColor White
    exit 1
}

Write-Host ""
Write-Host "Note: This test requires proper Stripe signature verification to be disabled" -ForegroundColor Yellow
Write-Host "      or you must use the Stripe CLI for testing." -ForegroundColor Yellow
Write-Host ""

# Prompt user to continue
$continue = Read-Host "Do you want to send this webhook event? (y/n)"
if ($continue -ne "y" -and $continue -ne "Y") {
    Write-Host "Test canceled." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Sending webhook event..." -ForegroundColor Cyan

# For testing, we'll just display the curl command
# In production, you'd use Stripe CLI or have signature verification disabled in test mode

$curlCommand = @"
curl -X POST $WebhookUrl \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=1699564800,v1=mock_signature_for_testing" \
  -d '@$EventFile'
"@

Write-Host ""
Write-Host "=== RECOMMENDED: Use Stripe CLI ===" -ForegroundColor Yellow
Write-Host ""
Write-Host "Option 1: Use Stripe CLI to trigger a test event:" -ForegroundColor Cyan
Write-Host "  stripe trigger payout.paid" -ForegroundColor White
Write-Host ""
Write-Host "Option 2: Forward real webhooks from Stripe:" -ForegroundColor Cyan
Write-Host "  stripe listen --forward-to http://localhost:7071/api/stripeWebhook" -ForegroundColor White
Write-Host ""
Write-Host "Option 3: Use curl (requires disabled signature verification):" -ForegroundColor Cyan
Write-Host $curlCommand -ForegroundColor White
Write-Host ""

# Provide instructions for verifying the result
Write-Host "=== After Sending the Webhook ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Check Salesforce for new Payout transaction:" -ForegroundColor Yellow
Write-Host "   - Navigate to Transaction__c tab" -ForegroundColor White
Write-Host "   - Use 'Recent Payouts' list view" -ForegroundColor White
Write-Host "   - Look for Stripe_Payout_Id__c = $($event.data.object.id)" -ForegroundColor White
Write-Host ""
Write-Host "2. Check QuickBooks for Bank Deposit:" -ForegroundColor Yellow
Write-Host "   - Navigate to Banking → Bank Deposits" -ForegroundColor White
Write-Host "   - Look for Doc Number = PO-$($event.data.object.id.Substring(0, [Math]::Min(15, $event.data.object.id.Length)))" -ForegroundColor White
Write-Host "   - Verify amount = `$$($event.data.object.amount / 100)" -ForegroundColor White
Write-Host ""
Write-Host "3. Verify Salesforce transaction is marked as Posted to QBO:" -ForegroundColor Yellow
Write-Host "   - Posted_to_QBO__c should be checked" -ForegroundColor White
Write-Host "   - QBO_Doc_Type__c should be 'bank-deposit'" -ForegroundColor White
Write-Host "   - QBO_Posted_At__c should have a timestamp" -ForegroundColor White
Write-Host ""

Write-Host "=== Test Complete ===" -ForegroundColor Green
