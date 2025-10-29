import type { InvocationContext, HttpRequest, HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import {
  postSalesReceipt,
  postJournalEntry,
  postBankDeposit,
  ensureItem,
  ensureCustomer,
  ensureAccount,
  query,
  type QuickBooksSalesReceipt,
  type QuickBooksJournalEntry,
  type QuickBooksBankDeposit,
} from '../services/qboSvc';
import { logger } from '../lib/logger';

type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

const ManualSyncRequestSchema = z.object({
  type: z.enum(['sales-receipt', 'journal-entry', 'bank-deposit']),
  data: z.record(z.any()), // Allow any object structure
});

type ManualSyncRequest = z.infer<typeof ManualSyncRequestSchema>;

// Extended data type for bank deposits with SalesReceiptIds
interface BankDepositData {
  DepositToAccountRef?: { name?: string; value?: string };
  TxnDate?: string;
  SalesReceiptIds?: string[]; // Array of sales receipt IDs to include in deposit
  Line?: any[]; // Optional manual line items (if SalesReceiptIds not provided)
  PrivateNote?: string;
}

interface ManualSyncResponse {
  success: boolean;
  id?: string;
  type?: QuickBooksDocType;
  error?: string;
}

// Calculate total amount from document lines
const calculateTotal = (data: any): number => {
  if (!data.Line || !Array.isArray(data.Line)) {
    return 0;
  }

  return data.Line.reduce((total: number, line: any) => {
    return total + (line.Amount || 0);
  }, 0);
};

// Generate DocNumber in format "MAN-YYYYMMDD-TOTAL"
const generateDocNumber = (total: number): string => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const totalStr = Math.abs(total).toFixed(2).replace('.', ''); // Remove decimal point for integer representation
  return `MAN-${dateStr}-${totalStr}`;
};

// Check for duplicate documents by DocNumber
const checkDuplicate = async (docNumber: string, type: QuickBooksDocType): Promise<boolean> => {
  try {
    let queryStr: string;

    switch (type) {
      case 'sales-receipt':
        queryStr = `SELECT Id FROM SalesReceipt WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
        break;
      case 'journal-entry':
        queryStr = `SELECT Id FROM JournalEntry WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
        break;
      case 'bank-deposit':
        queryStr = `SELECT Id FROM Deposit WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
        break;
      default:
        return false;
    }

    const result = await query<{ QueryResponse: any }>(queryStr);
    const responseKey = type === 'sales-receipt' ? 'SalesReceipt' :
                       type === 'journal-entry' ? 'JournalEntry' : 'Deposit';

    return !!(result.QueryResponse?.[responseKey]?.length > 0);
  } catch (error) {
    logger.warn(`Failed to check for duplicate ${type} with DocNumber ${docNumber}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    // If we can't check for duplicates, assume it's not a duplicate to avoid blocking
    return false;
  }
};

// Retrieve sales receipt from QBO by ID
const getSalesReceiptById = async (salesReceiptId: string): Promise<any | null> => {
  try {
    const queryStr = `SELECT * FROM SalesReceipt WHERE Id = '${salesReceiptId.replace(/'/g, "\\'")}'`;
    logger.info('Querying QuickBooks for sales receipt', {
      salesReceiptId,
      query: queryStr,
    });
    
    const result = await query<any>(queryStr);
    
    logger.info('QuickBooks query response', {
      salesReceiptId,
      isArray: Array.isArray(result),
      resultLength: Array.isArray(result) ? result.length : 0,
      hasQueryResponse: !!(result as any)?.QueryResponse,
    });
    
    // Handle array response (query function returns array directly)
    if (Array.isArray(result) && result.length > 0) {
      const salesReceipt = result[0];
      logger.info('Found sales receipt in QuickBooks', {
        salesReceiptId,
        docNumber: salesReceipt.DocNumber,
        totalAmt: salesReceipt.TotalAmt,
        depositToAccount: salesReceipt.DepositToAccountRef?.name,
      });
      return salesReceipt;
    }
    
    // Handle QueryResponse wrapper (fallback for different query implementations)
    if ((result as any)?.QueryResponse?.SalesReceipt) {
      const salesReceipts = (result as any).QueryResponse.SalesReceipt;
      if (salesReceipts.length > 0) {
        logger.info('Found sales receipt in QuickBooks (QueryResponse format)', {
          salesReceiptId,
          docNumber: salesReceipts[0].DocNumber,
          totalAmt: salesReceipts[0].TotalAmt,
        });
        return salesReceipts[0];
      }
    }
    
    logger.warn('Sales receipt not found in QuickBooks', {
      salesReceiptId,
    });
    return null;
  } catch (error) {
    logger.error(`Failed to retrieve sales receipt with ID ${salesReceiptId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Could not retrieve sales receipt ${salesReceiptId}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

// Build bank deposit lines from sales receipt IDs
const buildBankDepositFromSalesReceipts = async (
  salesReceiptIds: string[],
  context: InvocationContext
): Promise<{ lines: any[]; totalAmount: number }> => {
  const lines: any[] = [];
  let totalAmount = 0;

  logger.info('Building bank deposit from sales receipts', {
    salesReceiptIds,
    count: salesReceiptIds.length,
    invocationId: context.invocationId,
  });

  for (const salesReceiptId of salesReceiptIds) {
    const salesReceipt = await getSalesReceiptById(salesReceiptId);
    
    if (!salesReceipt) {
      throw new Error(`Sales receipt with ID ${salesReceiptId} not found in QuickBooks`);
    }

    // Verify that the sales receipt is deposited to Undeposited Funds
    const depositToAccount = salesReceipt.DepositToAccountRef?.name;
    if (depositToAccount && depositToAccount.toLowerCase() !== 'undeposited funds') {
      logger.warn(`Sales receipt ${salesReceiptId} is not in Undeposited Funds account`, {
        salesReceiptId,
        currentAccount: depositToAccount,
        invocationId: context.invocationId,
      });
    }

    // Get the total amount from the sales receipt
    const amount = salesReceipt.TotalAmt || 0;
    totalAmount += amount;

    // Create a deposit line referencing the sales receipt
    // In QuickBooks, LinkedTxn automatically associates the deposit with the original transaction
    // No need for explicit Entity - QuickBooks derives it from the LinkedTxn
    const depositLine: any = {
      Amount: amount,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        AccountRef: salesReceipt.DepositToAccountRef || { name: 'Undeposited Funds' },
      },
      LinkedTxn: [
        {
          TxnId: salesReceipt.Id,
          TxnType: 'SalesReceipt',
        },
      ],
    };

    // Add description with the DocNumber for reference
    const docNumber = salesReceipt.DocNumber || salesReceiptId;
    if (salesReceipt.CustomerRef?.name) {
      depositLine.Description = `${salesReceipt.CustomerRef.name} - ${docNumber}`;
    } else {
      depositLine.Description = docNumber;
    }

    lines.push(depositLine);

    logger.info(`Added sales receipt to deposit`, {
      salesReceiptId,
      docNumber,
      amount,
      invocationId: context.invocationId,
    });
  }

  logger.info('Bank deposit lines built successfully', {
    lineCount: lines.length,
    totalAmount,
    invocationId: context.invocationId,
  });

  return { lines, totalAmount };
};

// Validate that required references are resolved
const validateRequiredReferences = (data: any, type: QuickBooksDocType): void => {
  if (type === 'sales-receipt') {
    if (!data.DepositToAccountRef?.value) {
      throw new Error('DepositToAccountRef is required and must be resolved to a valid account ID');
    }
    if (!data.Line || !Array.isArray(data.Line)) {
      throw new Error('Line array is required');
    }
    for (let i = 0; i < data.Line.length; i++) {
      const line = data.Line[i];
      if (line.DetailType === 'SalesItemLineDetail') {
        if (!line.SalesItemLineDetail?.ItemRef?.value) {
          throw new Error(`Line ${i + 1}: ItemRef is required and must be resolved to a valid item ID`);
        }
        if (line.Amount == null || typeof line.Amount !== 'number' || line.Amount <= 0) {
          throw new Error(`Line ${i + 1}: Amount must be a positive number`);
        }
      }
    }
  } else if (type === 'journal-entry') {
    if (!data.Line || !Array.isArray(data.Line)) {
      throw new Error('Line array is required');
    }
    for (let i = 0; i < data.Line.length; i++) {
      const line = data.Line[i];
      if (line.DetailType === 'JournalEntryLineDetail') {
        if (!line.JournalEntryLineDetail?.AccountRef?.value) {
          throw new Error(`Line ${i + 1}: AccountRef is required and must be resolved to a valid account ID`);
        }
        if (line.Amount == null || typeof line.Amount !== 'number' || line.Amount <= 0) {
          throw new Error(`Line ${i + 1}: Amount must be a positive number`);
        }
      }
    }
  } else if (type === 'bank-deposit') {
    if (!data.DepositToAccountRef?.value) {
      throw new Error('DepositToAccountRef is required and must be resolved to a valid account ID');
    }
    if (!data.Line || !Array.isArray(data.Line)) {
      throw new Error('Line array is required');
    }
    for (let i = 0; i < data.Line.length; i++) {
      const line = data.Line[i];
      if (line.DetailType === 'DepositLineDetail') {
        if (!line.DepositLineDetail?.AccountRef?.value) {
          throw new Error(`Line ${i + 1}: AccountRef is required and must be resolved to a valid account ID`);
        }
        if (line.Amount == null || typeof line.Amount !== 'number' || line.Amount <= 0) {
          throw new Error(`Line ${i + 1}: Amount must be a positive number`);
        }
      }
    }
  }
};

// Remove null/undefined values from the object to avoid QuickBooks errors
const cleanPayload = (obj: any): any => {
  if (obj === null || obj === undefined) {
    return undefined;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(cleanPayload).filter(item => item !== undefined);
  }
  
  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = cleanPayload(value);
      if (cleanedValue !== undefined && cleanedValue !== null) {
        cleaned[key] = cleanedValue;
      }
    }
    return cleaned;
  }
  
  return obj;
};

// Recursively resolve ItemRef, CustomerRef, AccountRef, and other reference types in the document data
const resolveItemReferences = async (
  data: any, 
  context: InvocationContext,
  rootData?: any  // Root document for accessing BillEmail, etc.
): Promise<any> => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return Promise.all(data.map(item => resolveItemReferences(item, context, rootData || data)));
  }

  const resolved = { ...data };
  const root = rootData || data;  // Use root data if provided, otherwise current data is root

  // Handle any Ref field that has a name but no value
  for (const [key, value] of Object.entries(resolved)) {
    if (key.endsWith('Ref') && value && typeof value === 'object' && 'name' in value) {
      const refValue = value as { name: string; value?: string };
      if (refValue.name && !refValue.value) {
        try {
          let resolvedRef: { value: string; name: string } | null = null;

          if (key === 'ItemRef') {
            const itemResult = await ensureItem(refValue.name);
            resolvedRef = { value: itemResult.value, name: itemResult.name || refValue.name };
          } else if (key === 'CustomerRef') {
            // For customer refs, check for email at root document level
            let email: string | undefined;
            if (root.BillEmail?.Address) {
              email = root.BillEmail.Address;
            }
            
            context.log(`Resolving CustomerRef`, {
              name: refValue.name,
              email,
              hasRootBillEmail: !!root.BillEmail,
              rootBillEmailAddress: root.BillEmail?.Address,
            });
            
            const customerResult = await ensureCustomer(refValue.name, email);
            resolvedRef = { value: customerResult.value, name: customerResult.name || refValue.name };
            
            context.log(`CustomerRef resolved`, {
              name: refValue.name,
              resolvedValue: customerResult.value,
              resolvedName: customerResult.name,
            });
          } else if (key === 'AccountRef' || key.endsWith('AccountRef')) {
            // For accounts, use ensureAccount which will create if it doesn't exist
            // We need to determine the account type based on context
            let accountType: string | undefined;
            
            // Infer account type from the reference key or parent context
            if (key === 'DepositToAccountRef') {
              accountType = 'Bank'; // Bank accounts for deposits
            } else if (key === 'ItemAccountRef') {
              accountType = 'Income'; // Income accounts for items
            } else if (resolved.PostingType === 'Debit' || resolved.PostingType === 'Credit') {
              // For journal entries, default to Other Current Assets (can be customized)
              accountType = 'Other Current Asset';
            }
            
            const accountResult = await ensureAccount(refValue.name, accountType);
            resolvedRef = { value: accountResult.value, name: accountResult.name || refValue.name };
          }

          if (resolvedRef) {
            resolved[key] = resolvedRef;
            logger.info(`Resolved ${key} for "${refValue.name}" to ID: ${resolvedRef.value}`, {
              refType: key,
              originalName: refValue.name,
              resolvedId: resolvedRef.value,
              invocationId: context.invocationId,
            });
          } else {
            // Leave unresolved references as-is for validation
            logger.warn(`Could not resolve ${key} for "${refValue.name}"`, {
              refType: key,
              refName: refValue.name,
              invocationId: context.invocationId,
            });
          }
        } catch (error) {
          logger.warn(`Failed to resolve ${key}: ${refValue.name}`, {
            refType: key,
            refName: refValue.name,
            error: error instanceof Error ? error.message : String(error),
            invocationId: context.invocationId,
          });
          // Leave failed references as-is for validation
        }
      }
    }
  }

  // Recursively process all other properties
  for (const [key, value] of Object.entries(resolved)) {
    if (!key.endsWith('Ref')) {
      resolved[key] = await resolveItemReferences(value, context, root);
    }
  }

  return resolved;
};

const validateAndPost = async (
  type: QuickBooksDocType,
  data: any,
  context: InvocationContext
): Promise<ManualSyncResponse> => {
  try {
    logger.info(`Starting ${type} validation and resolution`, {
      type,
      hasCustomerRef: !!data.CustomerRef,
      hasBillEmail: !!data.BillEmail,
      billEmailAddress: data.BillEmail?.Address,
      customerRefName: data.CustomerRef?.name,
      hasSalesReceiptIds: !!(data.SalesReceiptIds && Array.isArray(data.SalesReceiptIds)),
      salesReceiptIdsCount: data.SalesReceiptIds?.length,
      invocationId: context.invocationId,
    });

    let resolvedData = data;
    
    // Special handling for bank-deposit with SalesReceiptIds
    if (type === 'bank-deposit' && data.SalesReceiptIds && Array.isArray(data.SalesReceiptIds)) {
      logger.info('Processing bank deposit with SalesReceiptIds', {
        salesReceiptIds: data.SalesReceiptIds,
        count: data.SalesReceiptIds.length,
        invocationId: context.invocationId,
      });

      // Validate SalesReceiptIds array is not empty
      if (data.SalesReceiptIds.length === 0) {
        throw new Error('SalesReceiptIds array cannot be empty for bank deposits');
      }

      // Build deposit lines from sales receipts
      const { lines, totalAmount } = await buildBankDepositFromSalesReceipts(data.SalesReceiptIds, context);

      // Construct the deposit data with the built lines
      resolvedData = {
        ...data,
        Line: lines,
      };

      // Remove SalesReceiptIds from the final payload (it's not a QBO field)
      delete resolvedData.SalesReceiptIds;

      logger.info('Bank deposit constructed from sales receipts', {
        lineCount: lines.length,
        totalAmount,
        invocationId: context.invocationId,
      });
    }

    // Resolve item references before posting
    resolvedData = await resolveItemReferences(resolvedData, context);

    logger.info(`References resolved for ${type}`, {
      type,
      customerRefValue: resolvedData.CustomerRef?.value,
      customerRefName: resolvedData.CustomerRef?.name,
      invocationId: context.invocationId,
    });

    // Validate required references and amounts
    validateRequiredReferences(type, resolvedData);

    // Use provided DocNumber or generate one if not provided
    const docNumber = resolvedData.DocNumber || generateDocNumber(calculateTotal(resolvedData));

    // Check for duplicates
    const isDuplicate = await checkDuplicate(docNumber, type);
    if (isDuplicate) {
      logger.warn(`Duplicate ${type} detected with DocNumber: ${docNumber}`, {
        type,
        docNumber,
        invocationId: context.invocationId,
      });
      return {
        success: false,
        error: `Document with DocNumber ${docNumber} already exists`,
      };
    }

    // Ensure DocNumber is set (either user-provided or auto-generated)
    const dataWithDocNumber = {
      ...resolvedData,
      DocNumber: docNumber,
    };

    // Clean the payload to remove any null/undefined values
    const cleanedData = cleanPayload(dataWithDocNumber);

    logger.info(`Using DocNumber: ${docNumber} for ${type}`, {
      type,
      docNumber,
      userProvided: !!resolvedData.DocNumber,
      invocationId: context.invocationId,
    });

    // Log the complete payload before sending to QuickBooks
    logger.info(`Complete payload for ${type} before posting`, {
      type,
      payload: JSON.stringify(cleanedData, null, 2),
      invocationId: context.invocationId,
    });

    let result;

    switch (type) {
      case 'sales-receipt':
        result = await postSalesReceipt(cleanedData as QuickBooksSalesReceipt);
        break;
      case 'journal-entry':
        result = await postJournalEntry(cleanedData as QuickBooksJournalEntry);
        break;
      case 'bank-deposit':
        result = await postBankDeposit(cleanedData as QuickBooksBankDeposit);
        break;
      default:
        throw new Error(`Unsupported QuickBooks document type: ${type}`);
    }

    logger.info(`Successfully synced ${type} with ID: ${result.id}`, {
      type,
      id: result.id,
      docNumber,
      invocationId: context.invocationId,
    });

    return {
      success: true,
      id: result.id,
      type: result.type,
    };
  } catch (error) {
    logger.error(`Failed to sync ${type} to QuickBooks`, {
      type,
      error: error instanceof Error ? error.message : String(error),
      invocationId: context.invocationId,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
};

export default async function manualQboSync(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const body = await request.json();

    const validationResult = ManualSyncRequestSchema.safeParse(body);
    if (!validationResult.success) {
      logger.warn('Invalid request body for manual QBO sync', {
        errors: validationResult.error.errors,
        invocationId: context.invocationId,
      });

      return {
        status: 400,
        jsonBody: {
          success: false,
          error: 'Invalid request body',
          details: validationResult.error.errors,
        },
      };
    }

    const { type, data } = validationResult.data;

    logger.info(`Processing manual QBO sync request`, {
      type,
      invocationId: context.invocationId,
    });

    const result = await validateAndPost(type, data, context);

    if (result.success) {
      return {
        status: 200,
        jsonBody: result,
      };
    } else {
      return {
        status: 500,
        jsonBody: result,
      };
    }
  } catch (error) {
    logger.error('Unexpected error in manual QBO sync handler', {
      error: error instanceof Error ? error.message : String(error),
      invocationId: context.invocationId,
    });

    return {
      status: 500,
      jsonBody: {
        success: false,
        error: 'Internal server error',
      },
    };
  }
}