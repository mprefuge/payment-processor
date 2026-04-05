import type { HttpResponseInit } from '@azure/functions';
import { createEventSvc } from '../services/eventSvc';
import { stripeClientFactory } from '../services/stripeClientFactory';

const CrmFactory = require('../services/salesforce/crmFactory');

const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const parseBooleanFlag = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) {
    return true;
  }

  if (FALSY_VALUES.has(normalized)) {
    return false;
  }

  return defaultValue;
};

const resolveStripeLiveMode = (): boolean => {
  const configuredMode =
    typeof process.env.STRIPE_MODE === 'string'
      ? process.env.STRIPE_MODE.trim().toLowerCase()
      : null;

  if (configuredMode === 'live') {
    return true;
  }

  if (configuredMode === 'test' || configuredMode === 'sandbox') {
    return false;
  }

  return !parseBooleanFlag(process.env.TEST_MODE, false);
};

export const getCrmConfig = () => ({
  provider: 'salesforce',
  config: {
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
  },
});

export const createEventHandlerService = async () => {
  const crmConfig = getCrmConfig();
  const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
  const salesforceConnection = await crmService.authenticate();
  const stripeClient = stripeClientFactory.getClient(resolveStripeLiveMode());

  return createEventSvc({
    salesforceConnection,
    stripeClient,
  });
};

export const createErrorResponse = (status: number, error: string): HttpResponseInit => ({
  status,
  jsonBody: {
    success: false,
    error,
  },
});
