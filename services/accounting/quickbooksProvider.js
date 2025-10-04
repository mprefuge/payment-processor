const BaseAccountingProvider = require('./baseAccountingProvider');
const QuickBooks = require('node-quickbooks');

/**
 * QuickBooks Online (QBO) Accounting Provider
 * Implements accounting operations for QuickBooks Online using the QuickBooks API
 */
class QuickBooksProvider extends BaseAccountingProvider {
    constructor(config) {
        super(config);
        this.companyId = config.companyId;
        this.oauthTokens = config.oauthTokens || {};
        this.environment = config.environment || 'sandbox'; // 'sandbox' or 'production'
        this.logger = console;
        
        // Initialize QuickBooks client if tokens are available
        this.qbo = null;
        if (this.oauthTokens.accessToken && this.companyId) {
            this._initializeClient();
        }
    }

    /**
     * Initialize QuickBooks client
     */
    _initializeClient() {
        const useSandbox = this.environment === 'sandbox';
        this.qbo = new QuickBooks(
            process.env.QBO_CLIENT_ID || '',
            process.env.QBO_CLIENT_SECRET || '',
            this.oauthTokens.accessToken,
            false, // no token secret needed for OAuth 2.0
            this.companyId,
            useSandbox,
            true, // debug
            null, // minorversion - use default
            '2.0', // oauth version
            this.oauthTokens.refreshToken
        );
    }

    /**
     * Execute API call with automatic token refresh on 401
     */
    async _executeWithTokenRefresh(apiCall) {
        try {
            return await apiCall();
        } catch (error) {
            // If 401, try to refresh token and retry once
            if (error.fault && error.fault.type === 'AUTHENTICATION') {
                this.logger.log('[QBO] Access token expired, refreshing...');
                await this.refreshTokens();
                return await apiCall();
            }
            throw error;
        }
    }

    /**
     * Ensure required chart of accounts exist
     */
    async ensureChartOfAccounts(accounts) {
        this.logger.log('[QBO] Ensuring chart of accounts:', accounts.map(a => a.name));
        
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }

        const accountMap = {};
        
        for (const account of accounts) {
            try {
                // Search for existing account by name using findAccounts
                const existingAccounts = await this._executeWithTokenRefresh(() => 
                    new Promise((resolve, reject) => {
                        this.qbo.findAccounts({ Name: account.name }, (err, data) => {
                            if (err) reject(err);
                            else resolve(data.QueryResponse.Account || []);
                        });
                    })
                );

                if (existingAccounts.length > 0) {
                    // Account exists
                    accountMap[account.name] = existingAccounts[0].Id;
                    this.logger.log(`[QBO] Found existing account: ${account.name} (ID: ${existingAccounts[0].Id})`);
                } else {
                    // Create new account
                    const newAccount = {
                        Name: account.name,
                        AccountType: account.type || 'Bank',
                        AccountSubType: account.subType || 'CashOnHand'
                    };

                    const created = await this._executeWithTokenRefresh(() =>
                        new Promise((resolve, reject) => {
                            this.qbo.createAccount(newAccount, (err, data) => {
                                if (err) reject(err);
                                else resolve(data);
                            });
                        })
                    );

                    accountMap[account.name] = created.Id;
                    this.logger.log(`[QBO] Created account: ${account.name} (ID: ${created.Id})`);
                }
            } catch (error) {
                this.logger.error(`[QBO] Error ensuring account ${account.name}:`, error.message);
                throw new Error(`Failed to ensure account "${account.name}": ${error.message}`);
            }
        }
        
        return accountMap;
    }

    /**
     * Upsert a journal entry (idempotent)
     */
    async upsertJournalEntry(journalEntry) {
        this.logger.log('[QBO] Upserting journal entry:', journalEntry.docNumber);
        
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }
        
        // Validate lines balance (amounts are in cents)
        const totalDebits = journalEntry.lines
            .filter(l => l.type === 'debit')
            .reduce((sum, l) => sum + l.amount, 0);
        const totalCredits = journalEntry.lines
            .filter(l => l.type === 'credit')
            .reduce((sum, l) => sum + l.amount, 0);
            
        if (Math.abs(totalDebits - totalCredits) > 1) { // Allow 1 cent tolerance
            throw new Error(`Journal entry lines do not balance: debits=${totalDebits / 100}, credits=${totalCredits / 100}`);
        }

        // Validate that all lines have valid account IDs
        for (const line of journalEntry.lines) {
            if (!line.accountId) {
                throw new Error(`Required parameter AccountRef is missing: Line missing accountId: ${JSON.stringify(line)}`);
            }
            // Check if accountId looks like a mock/invalid ID
            if (typeof line.accountId === 'string' && line.accountId.startsWith('account-')) {
                this.logger.warn(`[QBO] Warning: Line has suspicious account ID that may be invalid: ${line.accountId}`);
            }
        }

        this.logger.log(`[QBO] Journal entry has ${journalEntry.lines.length} lines, debits=$${(totalDebits / 100).toFixed(2)}, credits=$${(totalCredits / 100).toFixed(2)}`);

        try {
            // Search for existing JE by DocNumber using findJournalEntries
            const existingEntries = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.findJournalEntries({ DocNumber: journalEntry.docNumber }, (err, data) => {
                        if (err) reject(err);
                        else resolve(data.QueryResponse.JournalEntry || []);
                    });
                })
            );

            if (existingEntries.length > 0) {
                // Entry exists - return existing
                const existing = existingEntries[0];
                this.logger.log(`[QBO] Journal entry already exists: ${journalEntry.docNumber} (ID: ${existing.Id})`);
                return {
                    id: existing.Id,
                    docNumber: existing.DocNumber,
                    txnDate: existing.TxnDate,
                    syncToken: existing.SyncToken,
                    provider: 'quickbooks',
                    created: false
                };
            }

            // Create new journal entry
            const jeData = {
                DocNumber: journalEntry.docNumber,
                TxnDate: this._formatDate(journalEntry.date),
                PrivateNote: journalEntry.memo || '',
                Line: journalEntry.lines.map((line, index) => {
                    const linePayload = {
                        Id: (index + 1).toString(),
                        Description: line.memo || line.description || journalEntry.memo || '',
                        Amount: (line.amount / 100).toFixed(2), // Convert cents to dollars
                        DetailType: 'JournalEntryLineDetail',
                        JournalEntryLineDetail: {
                            PostingType: line.type === 'debit' ? 'Debit' : 'Credit',
                            AccountRef: {
                                value: line.accountId
                            }
                        }
                    };

                    if (line.name) {
                        linePayload.Name = line.name;
                    }

                    return linePayload;
                })
            };

            const created = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.createJournalEntry(jeData, (err, data) => {
                        if (err) {
                            this.logger.error('[QBO] Error creating journal entry:', err);
                            reject(err);
                        } else {
                            resolve(data);
                        }
                    });
                })
            );

            this.logger.log(`[QBO] Created journal entry: ${created.DocNumber} (ID: ${created.Id})`);
            
            return {
                id: created.Id,
                docNumber: created.DocNumber,
                txnDate: created.TxnDate,
                syncToken: created.SyncToken,
                provider: 'quickbooks',
                created: true
            };
        } catch (error) {
            this.logger.error('[QBO] Error upserting journal entry:', error);
            this.logger.error('[QBO] Error details:', {
                message: error.message,
                fault: error.Fault,
                stack: error.stack
            });
            
            // Extract error message from Fault if present
            let errorMessage = error.message;
            if (error.Fault && error.Fault.Error && Array.isArray(error.Fault.Error)) {
                const errors = error.Fault.Error.map(e => `${e.Message}: ${e.Detail || ''}`).join('; ');
                errorMessage = errors;
            }
            
            throw new Error(`Failed to upsert journal entry: ${errorMessage}`);
        }
    }

    /**
     * Upsert a transfer between accounts (idempotent)
     */
    async upsertTransfer(transfer) {
        this.logger.log('[QBO] Upserting transfer:', transfer.docNumber);
        
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }
        
        // Validate amount
        if (transfer.amount <= 0) {
            throw new Error('Transfer amount must be positive');
        }

        try {
            const transferDate = this._formatDate(transfer.date);
            const transferAmount = (transfer.amount / 100).toFixed(2);

            // Search for an existing transfer by date/amount and validate with metadata
            let existingTransfers = [];
            try {
                existingTransfers = await this._executeWithTokenRefresh(() =>
                    new Promise((resolve, reject) => {
                        this.qbo.findTransfers([
                            { field: 'TxnDate', value: transferDate, operator: '=' },
                            { field: 'Amount', value: transferAmount, operator: '=' }
                        ], (err, data) => {
                            if (err) reject(err);
                            else resolve(data.QueryResponse.Transfer || []);
                        });
                    })
                );
            } catch (searchError) {
                this.logger.warn('[QBO] Transfer lookup failed, will attempt to create new transfer:', searchError.message);
                existingTransfers = [];
            }

            const matchingTransfer = existingTransfers.find(existing => {
                const note = existing.PrivateNote || '';
                const fromAccountId = existing.FromAccountRef && existing.FromAccountRef.value;
                const toAccountId = existing.ToAccountRef && existing.ToAccountRef.value;

                return note.includes(transfer.docNumber) &&
                    fromAccountId === transfer.fromAccountId &&
                    toAccountId === transfer.toAccountId;
            });

            if (matchingTransfer) {
                this.logger.log(`[QBO] Transfer already exists: ${transfer.docNumber} (ID: ${matchingTransfer.Id})`);
                return {
                    id: matchingTransfer.Id,
                    docNumber: transfer.docNumber,
                    txnDate: matchingTransfer.TxnDate,
                    fromAccountRef: matchingTransfer.FromAccountRef,
                    toAccountRef: matchingTransfer.ToAccountRef,
                    amount: Math.round(parseFloat(matchingTransfer.Amount) * 100), // Convert dollars back to cents
                    provider: 'quickbooks',
                    created: false
                };
            }

            // Create new transfer
            const transferData = {
                FromAccountRef: {
                    value: transfer.fromAccountId
                },
                ToAccountRef: {
                    value: transfer.toAccountId
                },
                Amount: (transfer.amount / 100).toFixed(2), // Convert cents to dollars
                TxnDate: transferDate,
                PrivateNote: `${transfer.memo || ''} [DocNum: ${transfer.docNumber}]`
            };

            const created = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.createTransfer(transferData, (err, data) => {
                        if (err) {
                            this.logger.error('[QBO] Error creating transfer:', err);
                            reject(err);
                        } else {
                            resolve(data);
                        }
                    });
                })
            );

            this.logger.log(`[QBO] Created transfer: ${transfer.docNumber} (ID: ${created.Id})`);
            
            return {
                id: created.Id,
                docNumber: transfer.docNumber,
                txnDate: created.TxnDate,
                fromAccountRef: created.FromAccountRef,
                toAccountRef: created.ToAccountRef,
                amount: Math.round(parseFloat(created.Amount) * 100), // Convert dollars back to cents
                provider: 'quickbooks',
                created: true
            };
        } catch (error) {
            this.logger.error('[QBO] Error upserting transfer:', error);
            
            // Extract error message from Fault if present
            let errorMessage = error.message;
            if (error.Fault && error.Fault.Error && Array.isArray(error.Fault.Error)) {
                const errors = error.Fault.Error.map(e => `${e.Message}: ${e.Detail || ''}`).join('; ');
                errorMessage = errors;
            }
            
            throw new Error(`Failed to upsert transfer: ${errorMessage}`);
        }
    }

    /**
     * Upsert a bank deposit (idempotent)
     */
    async upsertDeposit(deposit) {
        this.logger.log('[QBO] Upserting deposit:', deposit.docNumber);
        
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }

        try {
            // Search for existing deposit by DocNumber
            let existingDeposits = [];
            try {
                existingDeposits = await this._executeWithTokenRefresh(() =>
                    new Promise((resolve, reject) => {
                        this.qbo.findDeposits([
                            { field: 'DocNumber', value: deposit.docNumber, operator: '=' }
                        ], (err, data) => {
                            if (err) reject(err);
                            else resolve(data.QueryResponse.Deposit || []);
                        });
                    })
                );
            } catch (searchError) {
                this.logger.warn('[QBO] Deposit lookup failed, will attempt to create new deposit:', searchError.message);
                existingDeposits = [];
            }

            if (existingDeposits.length > 0) {
                // Deposit exists - return existing
                const existing = existingDeposits[0];
                this.logger.log(`[QBO] Deposit already exists: ${deposit.docNumber} (ID: ${existing.Id})`);
                return {
                    id: existing.Id,
                    docNumber: deposit.docNumber,
                    txnDate: existing.TxnDate,
                    depositToAccountRef: existing.DepositToAccountRef,
                    totalAmt: Math.round(parseFloat(existing.TotalAmt) * 100), // Convert dollars back to cents
                    provider: 'quickbooks',
                    created: false
                };
            }

            // Create new deposit
            const depositData = {
                DocNumber: deposit.docNumber,
                DepositToAccountRef: {
                    value: deposit.toAccountId
                },
                TxnDate: this._formatDate(deposit.date),
                PrivateNote: `${deposit.memo || ''} [DocNum: ${deposit.docNumber}]`,
                Line: deposit.lines.map((line, index) => {
                    const linePayload = {
                        Id: (index + 1).toString(),
                        Amount: (line.amount / 100).toFixed(2), // Convert cents to dollars
                        DetailType: 'DepositLineDetail',
                        DepositLineDetail: {
                            AccountRef: {
                                value: line.accountId
                            }
                        },
                        Description: line.memo || line.description || deposit.memo || ''
                    };

                    if (line.name) {
                        linePayload.Name = line.name;
                    }

                    return linePayload;
                })
            };

            const created = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.createDeposit(depositData, (err, data) => {
                        if (err) {
                            this.logger.error('[QBO] Error creating deposit:', err);
                            reject(err);
                        } else {
                            resolve(data);
                        }
                    });
                })
            );

            this.logger.log(`[QBO] Created deposit: ${deposit.docNumber} (ID: ${created.Id})`);
            
            return {
                id: created.Id,
                docNumber: deposit.docNumber,
                txnDate: created.TxnDate,
                depositToAccountRef: created.DepositToAccountRef,
                totalAmt: Math.round(parseFloat(created.TotalAmt) * 100), // Convert dollars back to cents
                provider: 'quickbooks',
                created: true
            };
        } catch (error) {
            this.logger.error('[QBO] Error upserting deposit:', error);
            
            // Extract error message from Fault if present
            let errorMessage = error.message;
            if (error.Fault && error.Fault.Error && Array.isArray(error.Fault.Error)) {
                const errors = error.Fault.Error.map(e => `${e.Message}: ${e.Detail || ''}`).join('; ');
                errorMessage = errors;
            }
            
            throw new Error(`Failed to upsert deposit: ${errorMessage}`);
        }
    }

    /**
     * Attach a document to a transaction
     */
    async attachDocument(transactionId, attachment) {
        this.logger.log('[QBO] Attaching document to transaction:', transactionId);
        
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }

        try {
            // Note: Document attachment in QBO requires multipart upload
            // For now, we'll log the intent but not implement full attachment
            this.logger.warn('[QBO] Document attachment not fully implemented - would upload:', attachment.fileName);
            
            // In production, this would:
            // 1. Upload file to QBO using multipart/form-data
            // 2. Link attachment to transaction
            // 3. Return attachment ID
            
            return {
                id: `qbo-attachment-${Date.now()}`,
                fileName: attachment.fileName,
                transactionId: transactionId,
                status: 'pending_implementation'
            };
        } catch (error) {
            this.logger.error('[QBO] Error attaching document:', error);
            throw new Error(`Failed to attach document: ${error.message}`);
        }
    }

    /**
     * Health check - verify QBO connectivity
     */
    async healthCheck() {
        try {
            if (!this.companyId) {
                return {
                    healthy: false,
                    message: 'QBO company ID not configured',
                    details: { provider: 'quickbooks' }
                };
            }
            
            if (!this.oauthTokens.accessToken) {
                return {
                    healthy: false,
                    message: 'QBO OAuth tokens not configured',
                    details: { provider: 'quickbooks' }
                };
            }

            if (!this.qbo) {
                this._initializeClient();
            }

            // Make a lightweight API call to verify connectivity
            const companyInfo = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.getCompanyInfo(this.companyId, (err, data) => {
                        if (err) reject(err);
                        else resolve(data);
                    });
                })
            );

            this.logger.log(`[QBO] Successfully connected to: ${companyInfo.CompanyName}`);
            
            return {
                healthy: true,
                message: 'QBO connection healthy',
                details: {
                    provider: 'quickbooks',
                    environment: this.environment,
                    companyId: this.companyId,
                    companyName: companyInfo.CompanyName
                }
            };
        } catch (error) {
            this.logger.error('[QBO] Health check failed:', error);
            return {
                healthy: false,
                message: `QBO connection failed: ${error.message}`,
                details: { provider: 'quickbooks', error: error.message }
            };
        }
    }

    /**
     * Get account by ID
     */
    async getAccount(accountId) {
        this.logger.log('[QBO] Getting account:', accountId);
        
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }

        try {
            const account = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.getAccount(accountId, (err, data) => {
                        if (err) reject(err);
                        else resolve(data);
                    });
                })
            );

            return {
                id: account.Id,
                name: account.Name,
                accountType: account.AccountType,
                accountSubType: account.AccountSubType,
                currentBalance: parseFloat(account.CurrentBalance || 0)
            };
        } catch (error) {
            this.logger.error('[QBO] Error getting account:', error);
            throw new Error(`Failed to get account: ${error.message}`);
        }
    }

    /**
     * Find accounts by criteria
     */
    async findAccounts(criteria) {
        this.logger.log('[QBO] Finding accounts:', criteria);
        
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }

        try {
            // Build criteria array for findAccounts
            const queryCriteria = [];
            
            if (criteria.name) {
                queryCriteria.push({ field: 'Name', value: criteria.name });
            }
            if (criteria.type) {
                queryCriteria.push({ field: 'AccountType', value: criteria.type });
            }
            if (criteria.subType) {
                queryCriteria.push({ field: 'AccountSubType', value: criteria.subType });
            }

            // Use criteria object or array depending on what we have
            const findCriteria = queryCriteria.length > 0 ? queryCriteria : {};

            const accounts = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.findAccounts(findCriteria, (err, data) => {
                        if (err) reject(err);
                        else resolve(data.QueryResponse.Account || []);
                    });
                })
            );

            return accounts.map(account => ({
                id: account.Id,
                name: account.Name,
                accountType: account.AccountType,
                accountSubType: account.AccountSubType,
                currentBalance: parseFloat(account.CurrentBalance || 0)
            }));
        } catch (error) {
            this.logger.error('[QBO] Error finding accounts:', error);
            throw new Error(`Failed to find accounts: ${error.message}`);
        }
    }

    /**
     * Refresh OAuth tokens
     */
    async refreshTokens() {
        this.logger.log('[QBO] Refreshing OAuth tokens');
        
        if (!this.oauthTokens.refreshToken) {
            throw new Error('No refresh token available');
        }

        try {
            const refreshToken = await new Promise((resolve, reject) => {
                if (!this.qbo) {
                    this._initializeClient();
                }
                
                this.qbo.refreshAccessToken((err, data) => {
                    if (err) {
                        this.logger.error('[QBO] Error refreshing token:', err);
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });

            // Update stored tokens
            this.oauthTokens.accessToken = refreshToken.access_token;
            if (refreshToken.refresh_token) {
                this.oauthTokens.refreshToken = refreshToken.refresh_token;
            }

            // Reinitialize client with new token
            this._initializeClient();

            this.logger.log('[QBO] Successfully refreshed OAuth tokens');
            
            // Note: In production, you should persist these tokens to storage
            // so they can be used across sessions
            if (process.env.NODE_ENV === 'production') {
                this.logger.warn('[QBO] WARNING: Refreshed tokens should be persisted to storage (e.g., env vars, key vault)');
            }

            return true;
        } catch (error) {
            this.logger.error('[QBO] Failed to refresh tokens:', error);
            throw new Error(`Failed to refresh OAuth tokens: ${error.message}`);
        }
    }

    /**
     * Helper to format date for QBO API (YYYY-MM-DD)
     */
    _formatDate(date) {
        const d = new Date(date);
        return d.toISOString().split('T')[0];
    }
}

module.exports = QuickBooksProvider;
