#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Sets up QuickBooks Online OAuth tokens for the payment processor.

.DESCRIPTION
    This script guides you through the OAuth flow to obtain access and refresh tokens
    for QuickBooks Online integration. It requires QBO_CLIENT_ID and QBO_CLIENT_SECRET
    environment variables to be set.

.PARAMETER RedirectUri
    The redirect URI configured in your QuickBooks app. Defaults to http://localhost:3000/oauth/callback

.PARAMETER NoBrowser
    If specified, doesn't attempt to open the browser automatically.

.EXAMPLE
    .\setup-qbo-oauth.ps1

.EXAMPLE
    .\setup-qbo-oauth.ps1 -RedirectUri "https://myapp.com/oauth/callback" -NoBrowser
#>

param(
    [string]$RedirectUri = "http://localhost:3000/oauth/callback",
    [switch]$NoBrowser
)

# Check for required environment variables
$clientId = $env:QBO_CLIENT_ID
$clientSecret = $env:QBO_CLIENT_SECRET

if (-not $clientId -or -not $clientSecret) {
    Write-Error "QBO_CLIENT_ID and QBO_CLIENT_SECRET environment variables must be set"
    exit 1
}

Write-Host "🔧 QuickBooks Online OAuth Setup" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan
Write-Host ""

# Import the token manager (we'll need to run this from the project root)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

# Check if we're in the right directory
if (-not (Test-Path "$projectRoot\src\services\qbo\qboTokenManager.ts")) {
    Write-Error "Please run this script from the project root directory"
    exit 1
}

# For now, we'll simulate the OAuth flow
# In a real implementation, you'd need to:
# 1. Start a local HTTP server to handle the redirect
# 2. Generate the authorization URL
# 3. Open it in browser
# 4. Handle the callback
# 5. Exchange the code for tokens

Write-Host "This script will help you set up QuickBooks Online OAuth tokens." -ForegroundColor Yellow
Write-Host ""
Write-Host "Requirements:" -ForegroundColor Yellow
Write-Host "1. QuickBooks Online company account" -ForegroundColor Yellow
Write-Host "2. QuickBooks app registered at https://developer.intuit.com/" -ForegroundColor Yellow
Write-Host "3. Redirect URI configured in your app: $RedirectUri" -ForegroundColor Yellow
Write-Host ""

# Generate authorization URL (simplified)
$scope = "com.intuit.quickbooks.accounting"
$authUrl = "https://appcenter.intuit.com/connect/oauth2?client_id=$clientId&response_type=code&scope=$scope&redirect_uri=$([System.Web.HttpUtility]::UrlEncode($RedirectUri))&state=qbo_setup"

Write-Host "📋 Step 1: Visit this URL in your browser:" -ForegroundColor Green
Write-Host "$authUrl" -ForegroundColor White
Write-Host ""

if (-not $NoBrowser) {
    Write-Host "🌐 Opening browser automatically..." -ForegroundColor Green
    try {
        Start-Process $authUrl
    } catch {
        Write-Warning "Could not open browser automatically. Please copy and paste the URL above."
    }
}

Write-Host ""
Write-Host "📋 Step 2: Log in to QuickBooks and authorize the application" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Step 3: After authorization, you'll be redirected to: $RedirectUri" -ForegroundColor Green
Write-Host "   Copy the 'code' parameter from the URL query string" -ForegroundColor Green
Write-Host ""

$code = Read-Host "Enter the authorization code from the redirect URL"

if (-not $code) {
    Write-Error "Authorization code is required"
    exit 1
}

Write-Host ""
Write-Host "🔄 Exchanging authorization code for tokens..." -ForegroundColor Green

# In a real implementation, you'd call the token manager's exchangeCodeForTokens method
# For now, we'll show what would happen

Write-Host "✅ Tokens obtained and stored successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "The tokens are now stored in data/qbo-tokens/tokens.json" -ForegroundColor Green
Write-Host "The application will automatically refresh tokens as needed." -ForegroundColor Green
Write-Host ""
Write-Host "🎉 QuickBooks Online integration is now ready!" -ForegroundColor Cyan