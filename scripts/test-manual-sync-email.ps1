# Test Manual QBO Sync with Email
# This script helps test the email-based customer lookup

$body = @{
    type = "sales-receipt"
    data = @{
        DocNumber = "SR-TEST-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        TxnDate = "2024-01-15"
        PrivateNote = "Manual sync test with email"
        DepositToAccountRef = @{
            name = "Checking Account"
        }
        CustomerRef = @{
            name = "John Doe"
        }
        BillEmail = @{
            Address = "john.doe@example.com"
        }
        Line = @(
            @{
                Amount = 150.00
                DetailType = "SalesItemLineDetail"
                Description = "Consulting Services"
                SalesItemLineDetail = @{
                    ItemRef = @{
                        name = "Consulting"
                    }
                }
            }
        )
    }
} | ConvertTo-Json -Depth 10

Write-Host "Request Body:" -ForegroundColor Cyan
Write-Host $body
Write-Host ""
Write-Host "Making request to manual sync endpoint..." -ForegroundColor Yellow

# You'll need to update these values:
# $functionUrl = "https://your-function-app.azurewebsites.net/qbo/manual-sync"
# $functionKey = "your-function-key"

# Uncomment and update the following to actually make the request:
# $response = Invoke-RestMethod -Uri $functionUrl -Method Post -Body $body -Headers @{
#     "Content-Type" = "application/json"
#     "x-functions-key" = $functionKey
# }
# 
# Write-Host "Response:" -ForegroundColor Green
# $response | ConvertTo-Json -Depth 10

Write-Host ""
Write-Host "To use this script:" -ForegroundColor Cyan
Write-Host "1. Update the `$functionUrl and `$functionKey variables above"
Write-Host "2. Uncomment the Invoke-RestMethod section"
Write-Host "3. Run the script"
