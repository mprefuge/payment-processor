param(
  [int]$Amount = 5000,
  [string]$Frequency = "onetime",
  [string]$Campaign = "salesforce-test"
)

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "COMPLETE PAYMENT LIFECYCLE TEST" -ForegroundColor Cyan
Write-Host "Real session id from API + Campaign auto-resolution" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan

# Step 1: Create checkout session via API (captures REAL session id)
Write-Host "Step 1: Create checkout session (API)" -ForegroundColor Green
$createBody = @{
  amount = $Amount
  frequency = $Frequency
  customer = @{
    email = "sftest@example.com"
    firstname = "Salesforce"
    lastname  = "TestUser"
    address   = "123 SF Test St"
    city      = "San Francisco"
    state     = "CA"
    zipcode   = "94102"
  }
} | ConvertTo-Json -Depth 5 -Compress

$idempKey = "sf-test-" + (Get-Date -Format 'yyyyMMddHHmmss')
$createResp = Invoke-WebRequest -Uri "http://localhost:7071/api/transaction" -Method POST -ContentType "application/json" -Body $createBody -Headers @{"Idempotency-Key"=$idempKey} -UseBasicParsing
$session = $createResp.Content | ConvertFrom-Json
$sessionId = $session.id

if (-not $sessionId) {
  throw "API did not return a session id. Response: $($createResp.Content)"
}

# Keep ids consistent across events
$customerId = "cus_test_sf_" + (Get-Random -Maximum 999999)
$piId      = "pi_test_sf_" + (Get-Random -Maximum 999999)

Write-Host "   ✅ Session created: $sessionId" -ForegroundColor White

# Step 2: Simulate checkout.session.completed using the REAL session id from Step 1
Write-Host "`nStep 2: checkout.session.completed (uses real session id)" -ForegroundColor Green
$evt1 = "evt_sf_checkout_" + (Get-Random -Maximum 999999)
$payload1 = @{
  id = $evt1
  type = "checkout.session.completed"
  data = @{ object = @{
    id = $sessionId
    object = "checkout.session"
    status = "complete"
    amount_total = $Amount
    customer = $customerId
    payment_intent = $piId
    customer_details = @{ email = "sftest@example.com"; name = "Salesforce TestUser" }
    metadata = @{ campaign = $Campaign }
  }}
} | ConvertTo-Json -Depth 6 -Compress

try {
  $webhookResp1 = Invoke-WebRequest -Uri "http://localhost:7071/api/stripe/webhook" -Method POST -Body $payload1 -ContentType "application/json" -Headers @{ "stripe-signature" = "test" } -UseBasicParsing
  $wh1 = $webhookResp1.Content | ConvertFrom-Json
  Write-Host "   ✅ Webhook1: received=$($wh1.received), type=$($wh1.eventType)" -ForegroundColor White
} catch {
  Write-Host "   ⚠️  Webhook1 returned error (likely 400); continuing" -ForegroundColor Yellow
  try {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader $stream
    $content = $reader.ReadToEnd()
    $wh1 = $content | ConvertFrom-Json
    if ($wh1) { Write-Host "   → received=$($wh1.received), type=$($wh1.eventType)" -ForegroundColor White }
  } catch {}
}

Start-Sleep -Seconds 2

# Step 3: Simulate payment_intent.succeeded linking back to the SAME session id
Write-Host "`nStep 3: payment_intent.succeeded (links via checkout_session_id)" -ForegroundColor Green
$evt2 = "evt_sf_payment_" + (Get-Random -Maximum 999999)
$payload2 = @{
  id = $evt2
  type = "payment_intent.succeeded"
  data = @{ object = @{
    id = $piId
    object = "payment_intent"
    status = "succeeded"
    amount = $Amount
    customer = $customerId
    metadata = @{ campaign = $Campaign; checkout_session_id = $sessionId }
  }}
} | ConvertTo-Json -Depth 6 -Compress

try {
  $webhookResp2 = Invoke-WebRequest -Uri "http://localhost:7071/api/stripe/webhook" -Method POST -Body $payload2 -ContentType "application/json" -Headers @{ "stripe-signature" = "test" } -UseBasicParsing
  $wh2 = $webhookResp2.Content | ConvertFrom-Json
  Write-Host "   ✅ Webhook2: received=$($wh2.received), type=$($wh2.eventType)" -ForegroundColor White
} catch {
  Write-Host "   ⚠️  Webhook2 returned error (likely 400); continuing" -ForegroundColor Yellow
  try {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader $stream
    $content = $reader.ReadToEnd()
    $wh2 = $content | ConvertFrom-Json
    if ($wh2) { Write-Host "   → received=$($wh2.received), type=$($wh2.eventType)" -ForegroundColor White }
  } catch {}
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "VERIFICATION" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "[OK] Test Complete! Verifying results..." -ForegroundColor Green
Write-Host "`nExpected Outcomes:" -ForegroundColor Yellow
Write-Host "   1. Single Transaction in Salesforce" -ForegroundColor White
Write-Host "      - Stripe_Checkout_Session_Id__c = $sessionId" -ForegroundColor Gray
Write-Host "      - Stripe_Payment_Intent_Id__c = $piId" -ForegroundColor Gray
Write-Host "      - Status__c = paid" -ForegroundColor Gray
Write-Host "      - Campaign__c populated with Campaign ID" -ForegroundColor Gray
Write-Host ""
Write-Host "   2. Campaign in Salesforce" -ForegroundColor White
Write-Host "      - Name = $Campaign" -ForegroundColor Gray
Write-Host "      - Status = In Progress" -ForegroundColor Gray
Write-Host ""
Write-Host "   3. QuickBooks Sales Receipt" -ForegroundColor White
Write-Host "      - Posted_to_QBO__c = true" -ForegroundColor Gray
Write-Host "      - QBO_Doc_Type__c = SalesReceipt (or similar)" -ForegroundColor Gray
Write-Host "      - QBO_Doc_Id__c populated" -ForegroundColor Gray
Write-Host "      - Amount = `$$($Amount/100) (gross)" -ForegroundColor Gray
Write-Host ""
Write-Host "Function Logs to Check:" -ForegroundColor Yellow
Write-Host "   - [StripeWebhook] Campaign resolved to Salesforce ID" -ForegroundColor White
Write-Host "   - [StripeWebhook] Found existing transaction by checkout session ID" -ForegroundColor White
Write-Host "   - [StripeWebhook] Transaction upserted successfully ... wasUpdate: true" -ForegroundColor White
Write-Host "   - QBO posting success logs" -ForegroundColor White
Write-Host ""
Write-Host "Manual Verification Steps:" -ForegroundColor Yellow
Write-Host "   1. Go to Salesforce > Transactions" -ForegroundColor White
Write-Host "   2. Search for Payment Intent: $piId" -ForegroundColor White
Write-Host "   3. Verify all fields populated correctly" -ForegroundColor White
Write-Host "   4. Check Campaign lookup is populated" -ForegroundColor White
Write-Host "   5. Verify Posted to QBO checkbox is checked" -ForegroundColor White
Write-Host "   6. Check QBO Doc Type and ID fields" -ForegroundColor White
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "Test IDs for reference:" -ForegroundColor Yellow
Write-Host "  Session ID:   $sessionId" -ForegroundColor White
Write-Host "  Payment ID:   $piId" -ForegroundColor White
Write-Host "  Customer ID:  $customerId" -ForegroundColor White
Write-Host "  Campaign:     $Campaign" -ForegroundColor White
Write-Host "=======================================`n" -ForegroundColor Cyan
