param(
  [int]$Amount = 5000,
  [string]$Campaign = "salesforce-test"
)

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "QUICK PAYMENT INTENT TEST" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$eventId = "evt_quick_" + (Get-Random -Maximum 999999)
$piId = "pi_test_quick_" + (Get-Random -Maximum 999999)
$sessionId = "cs_test_quick_" + (Get-Random -Maximum 999999)

Write-Host "Event ID:   $eventId" -ForegroundColor White
Write-Host "Payment ID: $piId" -ForegroundColor White
Write-Host "Session ID: $sessionId" -ForegroundColor White
Write-Host "Amount:     `$$($Amount/100)" -ForegroundColor White
Write-Host "Campaign:   $Campaign`n" -ForegroundColor White

$payload = @{
  id = $eventId
  type = "payment_intent.succeeded"
  data = @{
    object = @{
      id = $piId
      object = "payment_intent"
      amount = $Amount
      amount_received = $Amount
      status = "succeeded"
      customer = "cus_test_quick"
      metadata = @{
        campaign = $Campaign
        checkout_session_id = $sessionId
      }
    }
  }
} | ConvertTo-Json -Depth 5 -Compress

Write-Host "Sending payment_intent.succeeded webhook..." -ForegroundColor Yellow

try {
  $response = Invoke-WebRequest -Uri "http://localhost:7071/api/stripe/webhook" -Method POST -Body $payload -ContentType "application/json" -Headers @{ "stripe-signature" = "test" } -UseBasicParsing
  $result = $response.Content | ConvertFrom-Json
  Write-Host "[OK] Webhook processed successfully" -ForegroundColor Green
  Write-Host "     Received: $($result.received)" -ForegroundColor White
  Write-Host "     Type: $($result.eventType)" -ForegroundColor White
} catch {
  Write-Host "[ERROR] Webhook failed" -ForegroundColor Red
  Write-Host $_ -ForegroundColor Red
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "CHECK FUNCTION LOGS FOR:" -ForegroundColor Yellow
Write-Host "  - Campaign resolved to Salesforce ID" -ForegroundColor White
Write-Host "  - Balance transaction retrieved" -ForegroundColor White
Write-Host "  - QBO posting attempted" -ForegroundColor White
Write-Host "  - Transaction marked as posted" -ForegroundColor White
Write-Host "`nPayment Intent ID: $piId" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan
