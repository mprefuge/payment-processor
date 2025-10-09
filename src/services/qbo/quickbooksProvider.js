const BaseAccountingProvider = require('./baseAccountingProvider');
const QuickBooks = require('node-quickbooks');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const MAX_VENDOR_ACCOUNT_NUMBER_LENGTH = 30;

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

    _normalizeEmail(value) {
        if (value === null || value === undefined) {
            return null;
        }

        const email = value.toString().trim();

        if (email.length === 0) {
            return null;
        }

        if (!EMAIL_REGEX.test(email)) {
            if (this.logger && typeof this.logger.warn === 'function') {
                this.logger.warn(`[QBO] Skipping invalid email address: ${email}`);
            }
            return null;
        }

        return email.toLowerCase();
    }

    _sanitizeVendorExternalId(externalId) {
        if (externalId === null || externalId === undefined) {
            return null;
        }

        const value = externalId.toString().trim();

        if (value.length === 0) {
            return null;
        }

        if (value.length > MAX_VENDOR_ACCOUNT_NUMBER_LENGTH) {
            if (this.logger && typeof this.logger.warn === 'function') {
                this.logger.warn(`[QBO] Truncating vendor external ID to ${MAX_VENDOR_ACCOUNT_NUMBER_LENGTH} characters`);
            }
            return value.substring(0, MAX_VENDOR_ACCOUNT_NUMBER_LENGTH);
        }

        return value;
    }

    _extractQboErrorMessage(error, fallback = 'Unknown QuickBooks error') {
        if (!error) {
            return fallback;
        }

        if (error.Fault && Array.isArray(error.Fault.Error) && error.Fault.Error.length > 0) {
            const parts = error.Fault.Error.map(err => {
                if (!err) {
                    return null;
                }

                const segments = [];
                if (err.Message && typeof err.Message === 'string') {
                    segments.push(err.Message.trim());
                }
                if (err.Detail && typeof err.Detail === 'string') {
                    segments.push(err.Detail.trim());
                }

                const message = segments.filter(Boolean).join(': ').trim();
                return message.length > 0 ? message : null;
            }).filter(Boolean);

            if (parts.length > 0) {
                return parts.join('; ');
            }
        }

        if (typeof error.message === 'string' && error.message.trim().length > 0) {
            return error.message;
        }

        if (typeof error === 'string' && error.trim().length > 0) {
            return error.trim();
        }

        return fallback;
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
     * Ensure a customer exists in QuickBooks and return its reference
     */
    async ensureCustomer(customer) {
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }

        const displayNameSource = customer.displayName || customer.name || customer.email || customer.externalId || 'Stripe Customer';
        const displayName = displayNameSource.toString().trim().substring(0, 99) || 'Stripe Customer';
        const normalizedEmail = this._normalizeEmail(customer.email);
        const normalizedDisplayName = displayName.toLowerCase();
        const existingCustomers = [];

        const uniqueById = (list) => {
            const seen = new Set();
            return list.filter(item => {
                if (!item || !item.Id) {
                    return false;
                }
                if (seen.has(item.Id)) {
                    return false;
                }
                seen.add(item.Id);
                return true;
            });
        };

        try {
            if (normalizedEmail) {
                const emailMatches = await this._executeWithTokenRefresh(() =>
                    new Promise((resolve, reject) => {
                        this.qbo.findCustomers([
                            { field: 'PrimaryEmailAddr', operator: '=', value: normalizedEmail }
                        ], (err, data) => {
                            if (err) reject(err);
                            else resolve((data.QueryResponse && data.QueryResponse.Customer) || []);
                        });
                    })
                );

                existingCustomers.push(...emailMatches);
            }

            if (existingCustomers.length === 0 && normalizedDisplayName) {
                const nameMatches = await this._executeWithTokenRefresh(() =>
                    new Promise((resolve, reject) => {
                        this.qbo.findCustomers({ DisplayName: displayName }, (err, data) => {
                            if (err) reject(err);
                            else resolve((data.QueryResponse && data.QueryResponse.Customer) || []);
                        });
                    })
                );

                existingCustomers.push(...nameMatches);
            }
        } catch (error) {
            this.logger.error('[QBO] Error searching for customer:', error.message);
            throw new Error(`Failed to look up customer "${displayName}": ${error.message}`);
        }

        const customers = uniqueById(existingCustomers);
        const matchedCustomer = customers.find(cust => {
            if (!cust) {
                return false;
            }

            const emailMatch = normalizedEmail && cust.PrimaryEmailAddr && cust.PrimaryEmailAddr.Address &&
                cust.PrimaryEmailAddr.Address.toString().trim().toLowerCase() === normalizedEmail;
            const nameMatch = cust.DisplayName && cust.DisplayName.toString().trim().toLowerCase() === normalizedDisplayName;
            return emailMatch || nameMatch;
        });

        if (matchedCustomer) {
            this.logger.log(`[QBO] Found existing customer: ${matchedCustomer.DisplayName} (ID: ${matchedCustomer.Id})`);
            return {
                id: matchedCustomer.Id,
                displayName: matchedCustomer.DisplayName || displayName
            };
        }

        const newCustomer = {
            DisplayName: displayName
        };

        if (customer.givenName) {
            newCustomer.GivenName = customer.givenName;
        }
        if (customer.familyName) {
            newCustomer.FamilyName = customer.familyName;
        }
        if (normalizedEmail) {
            newCustomer.PrimaryEmailAddr = { Address: normalizedEmail };
        }
        if (customer.externalId) {
            newCustomer.Notes = `Stripe Customer ID: ${customer.externalId}`;
        }

        try {
            const created = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.createCustomer(newCustomer, (err, data) => {
                        if (err) reject(err);
                        else resolve(data);
                    });
                })
            );

            this.logger.log(`[QBO] Created customer: ${created.DisplayName || displayName} (ID: ${created.Id})`);

            return {
                id: created.Id,
                displayName: created.DisplayName || displayName
            };
        } catch (error) {
            const errorMessage = this._extractQboErrorMessage(error);
            this.logger.error('[QBO] Error creating customer:', errorMessage);
            throw new Error(`Failed to create customer "${displayName}": ${errorMessage}`);
        }
    }

    /**
     * Ensure a vendor exists in QuickBooks and return its reference
     */
    async ensureVendor(vendor) {
        if (!this.qbo) {
            throw new Error('QuickBooks client not initialized. Check configuration.');
        }

        const displayNameSource = vendor.displayName || vendor.name || 'Stripe';
        const displayName = displayNameSource.toString().trim().substring(0, 99) || 'Stripe';
        const normalizedEmail = this._normalizeEmail(vendor.email);
        const normalizedDisplayName = displayName.toLowerCase();

        const uniqueById = (list) => {
            const seen = new Set();
            return list.filter(item => {
                if (!item || !item.Id) {
                    return false;
                }
                if (seen.has(item.Id)) {
                    return false;
                }
                seen.add(item.Id);
                return true;
            });
        };

        let existingVendors = [];

        try {
            if (normalizedEmail) {
                const emailMatches = await this._executeWithTokenRefresh(() =>
                    new Promise((resolve, reject) => {
                        this.qbo.findVendors([
                            { field: 'PrimaryEmailAddr', operator: '=', value: normalizedEmail }
                        ], (err, data) => {
                            if (err) reject(err);
                            else resolve((data.QueryResponse && data.QueryResponse.Vendor) || []);
                        });
                    })
                );

                existingVendors.push(...emailMatches);
            }

            if (existingVendors.length === 0 && normalizedDisplayName) {
                const nameMatches = await this._executeWithTokenRefresh(() =>
                    new Promise((resolve, reject) => {
                        this.qbo.findVendors({ DisplayName: displayName }, (err, data) => {
                            if (err) reject(err);
                            else resolve((data.QueryResponse && data.QueryResponse.Vendor) || []);
                        });
                    })
                );

                existingVendors.push(...nameMatches);
            }
        } catch (error) {
            this.logger.error('[QBO] Error searching for vendor:', error.message);
            throw new Error(`Failed to look up vendor "${displayName}": ${error.message}`);
        }

        const vendors = uniqueById(existingVendors);
        const matchedVendor = vendors.find(v => {
            if (!v) {
                return false;
            }

            const emailMatch = normalizedEmail && v.PrimaryEmailAddr && v.PrimaryEmailAddr.Address &&
                v.PrimaryEmailAddr.Address.toString().trim().toLowerCase() === normalizedEmail;
            const nameMatch = v.DisplayName && v.DisplayName.toString().trim().toLowerCase() === normalizedDisplayName;
            return emailMatch || nameMatch;
        });

        if (matchedVendor) {
            this.logger.log(`[QBO] Found existing vendor: ${matchedVendor.DisplayName} (ID: ${matchedVendor.Id})`);
            return {
                id: matchedVendor.Id,
                displayName: matchedVendor.DisplayName || displayName
            };
        }

        const newVendor = {
            DisplayName: displayName
        };

        if (normalizedEmail) {
            newVendor.PrimaryEmailAddr = { Address: normalizedEmail };
        }

        const sanitizedExternalId = this._sanitizeVendorExternalId(vendor.externalId);
        if (sanitizedExternalId) {
            newVendor.AcctNum = sanitizedExternalId;
        }

        try {
            const created = await this._executeWithTokenRefresh(() =>
                new Promise((resolve, reject) => {
                    this.qbo.createVendor(newVendor, (err, data) => {
                        if (err) reject(err);
                        else resolve(data);
                    });
                })
            );

            this.logger.log(`[QBO] Created vendor: ${created.DisplayName || displayName} (ID: ${created.Id})`);

            return {
                id: created.Id,
                displayName: created.DisplayName || displayName
            };
        } catch (error) {
            const errorMessage = this._extractQboErrorMessage(error);
            this.logger.error('[QBO] Error creating vendor:', errorMessage);
            throw new Error(`Failed to create vendor "${displayName}": ${errorMessage}`);
        }
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
            const buildLineDescription = (line) => {
                const parts = [];
                const addPart = (value) => {
                    if (!value || typeof value !== 'string') {
                        return;
                    }

                    const trimmed = value.trim();
                    if (trimmed.length === 0) {
                        return;
                    }

                    if (!parts.includes(trimmed)) {
                        parts.push(trimmed);
                    }
                };

                addPart(line.description);
                addPart(line.memo);
                addPart(journalEntry.memo);

                return parts.join(' | ');
            };

            const jeData = {
                DocNumber: journalEntry.docNumber,
                TxnDate: this._formatDate(journalEntry.date),
                PrivateNote: journalEntry.memo || '',
                Line: journalEntry.lines.map((line, index) => {
                    const jeLine = {
                        Id: (index + 1).toString(),
                        Description: buildLineDescription(line) || '',
                        Amount: (line.amount / 100).toFixed(2), // Convert cents to dollars
                        DetailType: 'JournalEntryLineDetail',
                        JournalEntryLineDetail: {
                            PostingType: line.type === 'debit' ? 'Debit' : 'Credit',
                            AccountRef: {
                                value: line.accountId
                            }
                        }
                    };

                    if (line) {
                        const entityRef = typeof line.entityRef === 'object' && line.entityRef
                            ? { ...line.entityRef }
                            : {};

                        const entityId = entityRef.value
                            || line.entityRefValue
                            || line.entityId
                            || (line.entity && line.entity.id);

                        const entityName = entityRef.name
                            || (line.entity && line.entity.name)
                            || line.entityRefName
                            || line.name;

                        const entityType = entityRef.type
                            || (line.entity && line.entity.type)
                            || line.entityType
                            || (line.entityContext === 'transaction' ? 'Customer' : 'Other');

                        if (entityId) {
                            jeLine.JournalEntryLineDetail.Entity = {
                                Type: entityType,
                                EntityRef: {
                                    value: entityId
                                }
                            };

                            if (entityName) {
                                jeLine.JournalEntryLineDetail.Entity.EntityRef.name = entityName;
                            }
                        } else if (entityName) {
                            this.logger.warn(
                                `[QBO] Skipping entity reference for journal line ${index + 1} (${entityName}) - missing entity identifier`
                            );

                            if (typeof jeLine.Description === 'string') {
                                const trimmedName = entityName.trim();
                                if (trimmedName.length > 0 && !jeLine.Description.includes(trimmedName)) {
                                    jeLine.Description = jeLine.Description.length > 0
                                        ? `${jeLine.Description} | ${trimmedName}`
                                        : trimmedName;
                                }
                            }
                        }
                    }

                    return jeLine;
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
                Line: deposit.lines.map((line, index) => ({
                    Id: (index + 1).toString(),
                    Amount: (line.amount / 100).toFixed(2), // Convert cents to dollars
                    DetailType: 'DepositLineDetail',
                    DepositLineDetail: {
                        AccountRef: {
                            value: line.accountId
                        }
                    },
                    Description: line.memo || line.description || deposit.memo || ''
                }))
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
            const refreshResponse = await new Promise((resolve, reject) => {
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

            if (!refreshResponse || typeof refreshResponse !== 'object') {
                throw new Error('Invalid token refresh response from QuickBooks');
            }

            if (!refreshResponse.access_token || refreshResponse.error) {
                const errorDescription = refreshResponse.error_description || refreshResponse.error || 'Missing access token';
                throw new Error(errorDescription);
            }

            // Update stored tokens
            this.oauthTokens.accessToken = refreshResponse.access_token;
            if (refreshResponse.refresh_token) {
                this.oauthTokens.refreshToken = refreshResponse.refresh_token;
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
            const message = error && error.message ? error.message : 'Unknown error';
            throw new Error(`Failed to refresh OAuth tokens: ${message}`);
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
