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
    if (key.endsWith('Ref') && value && typeof value === 'object' && 'name' in value && 'value' in value) {
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
      invocationId: context.invocationId,
    });

    // Resolve item references before posting
    const resolvedData = await resolveItemReferences(data, context);

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

    logger.info(`Using DocNumber: ${docNumber} for ${type}`, {
      type,
      docNumber,
      userProvided: !!resolvedData.DocNumber,
      invocationId: context.invocationId,
    });

    let result;

    switch (type) {
      case 'sales-receipt':
        result = await postSalesReceipt(dataWithDocNumber as QuickBooksSalesReceipt);
        break;
      case 'journal-entry':
        result = await postJournalEntry(dataWithDocNumber as QuickBooksJournalEntry);
        break;
      case 'bank-deposit':
        result = await postBankDeposit(dataWithDocNumber as QuickBooksBankDeposit);
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