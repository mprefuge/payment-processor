#!/usr/bin/env node

/**
 * QuickBooks Online OAuth Setup Script
 *
 * This script handles the OAuth flow to obtain access and refresh tokens
 * for QuickBooks Online integration. Designed for local development setup.
 *
 * For Azure Functions, run this locally to get initial tokens, then deploy
 * the refresh token as an environment variable.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { logger } from '../src/lib/logger';
import tokenManager from '../src/services/qbo/qboTokenManager';
import env from '../src/config/env';

const DEFAULT_PORT = 3000;
const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_PORT}/oauth/callback`;

interface SetupOptions {
  port?: number;
  redirectUri?: string;
  noBrowser?: boolean;
}

async function setupQBOOAuth(options: SetupOptions = {}): Promise<void> {
  const port = options.port || DEFAULT_PORT;
  const redirectUri =
    options.redirectUri ||
    env.quickBooks.redirectUri ||
    DEFAULT_REDIRECT_URI;

  // Check required environment variables
  if (!env.quickBooks.clientId || !env.quickBooks.clientSecret) {
    throw new Error(
      'QBO_CLIENT_ID and QBO_CLIENT_SECRET environment variables must be set'
    );
  }

  console.log('🔧 QuickBooks Online OAuth Setup (Local Development)');
  console.log('===================================================');
  console.log('');
  console.log('This script is designed for LOCAL DEVELOPMENT setup.');
  console.log('For Azure Functions, run this locally to obtain tokens, then:');
  console.log('1. Copy the refresh token from the output');
  console.log('2. Set QBO_REFRESH_TOKEN in your Azure Function environment');
  console.log('3. Deploy your function - it will handle token refresh automatically');
  console.log('');

  // Generate authorization URL
  const authUrl = tokenManager.generateAuthorizationUrl(redirectUri);

  console.log('📋 Step 1: Visit this URL in your browser:');
  console.log(authUrl);
  console.log('');

  if (!options.noBrowser) {
    console.log('🌐 Opening browser automatically...');
    try {
      // Try to open browser (platform dependent)
      const { exec } = await import('child_process');
      const command = process.platform === 'darwin' ? 'open' :
                     process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${command} "${authUrl}"`);
    } catch (error) {
      console.warn('Could not open browser automatically. Please copy and paste the URL above.');
    }
  }

  console.log('');
  console.log('📋 Step 2: Log in to QuickBooks and authorize the application');
  console.log('');
  console.log(`📋 Step 3: After authorization, you'll be redirected to: ${redirectUri}`);
  console.log('   The server will handle the callback and obtain tokens automatically.');
  console.log('');

  // Start local server to handle the callback
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url!, `http://localhost:${port}`);
        const { pathname } = url;

        if (pathname === '/oauth/callback') {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            const errorDescription = url.searchParams.get('error_description');
            throw new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`);
          }

          if (!code) {
            throw new Error('No authorization code received');
          }

          if (state !== 'qbo_setup') {
            throw new Error('Invalid state parameter');
          }

          console.log('');
          console.log('🔄 Received authorization code, exchanging for tokens...');

          // Exchange code for tokens
          const tokens = await tokenManager.exchangeCodeForTokens(code, redirectUri, fetch);

          // Send success response
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>QuickBooks OAuth Setup Complete</title>
  <style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
    .success { color: #28a745; }
    .info { color: #17a2b8; }
    .token { background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; margin: 10px 0; }
  </style>
</head>
<body>
  <h1 class="success">✅ Setup Complete!</h1>
  <p class="info">QuickBooks Online tokens have been obtained and stored.</p>
  <p><strong>For Azure Functions:</strong> Set this environment variable:</p>
  <div class="token">QBO_REFRESH_TOKEN=${tokens.refreshToken}</div>
  <p>You can now close this window and deploy your function.</p>
</body>
</html>
          `);

          console.log('✅ Tokens obtained and stored successfully!');
          console.log('');
          console.log('The tokens are now stored in data/qbo-tokens/tokens.json');
          console.log('');
          console.log('🚀 For Azure Functions deployment:');
          console.log(`   Set environment variable: QBO_REFRESH_TOKEN=${tokens.refreshToken}`);
          console.log('');
          console.log('🎉 QuickBooks Online integration is now ready!');

          server.close();
          resolve();
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (error) {
        console.error('❌ Setup failed:', error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>QuickBooks OAuth Setup Failed</title>
  <style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
    .error { color: #dc3545; }
  </style>
</head>
<body>
  <h1 class="error">❌ Setup Failed</h1>
  <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
  <p>Please check the console for more details.</p>
</body>
</html>
        `);
        server.close();
        reject(error);
      }
    });

    server.listen(port, () => {
      console.log(`🚀 Local server started on http://localhost:${port}`);
      console.log('Waiting for OAuth callback...');
      console.log('');
    });

    // Timeout after 10 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Setup timed out after 10 minutes'));
    }, 10 * 60 * 1000);
  });
}

// CLI interface
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options: SetupOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        options.port = parseInt(args[++i], 10);
        break;
      case '--redirect-uri':
      case '-r':
        options.redirectUri = args[++i];
        break;
      case '--no-browser':
      case '-n':
        options.noBrowser = true;
        break;
      case '--help':
      case '-h':
        console.log(`
QuickBooks Online OAuth Setup

Usage: setup-qbo-oauth [options]

Options:
  -p, --port <port>           Port for local server (default: 3000)
  -r, --redirect-uri <uri>    Redirect URI (default: http://localhost:3000/oauth/callback)
  -n, --no-browser            Don't open browser automatically
  -h, --help                  Show this help

Environment Variables:
  QBO_CLIENT_ID               QuickBooks OAuth Client ID (required)
  QBO_CLIENT_SECRET           QuickBooks OAuth Client Secret (required)
        `);
        return;
    }
  }

  try {
    await setupQBOOAuth(options);
  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { setupQBOOAuth };