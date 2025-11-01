/**
 * Event Check-In HTTP Handler
 * Handles event check-in requests
 */

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createEventSvc } from '../services/eventSvc';
import type { EventCheckInRequest } from '../types/events';
import { stripeClientFactory } from '../services/stripeClientFactory';
const CrmFactory = require('../services/salesforce/crmFactory');

/**
 * Get Salesforce CRM configuration
 */
const getCrmConfig = () => {
  return {
    provider: 'salesforce',
    config: {
      username: process.env.SALESFORCE_USERNAME,
      password: process.env.SALESFORCE_PASSWORD,
      securityToken: process.env.SALESFORCE_SECURITY_TOKEN,
      loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
    },
  };
};

export default async function eventCheckIn(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Event check-in request received');

  try {
    // Parse request body
    const requestBody = (await request.json()) as EventCheckInRequest;

    if (!requestBody) {
      return {
        status: 400,
        jsonBody: {
          success: false,
          error: 'Request body is required',
        },
      };
    }

    // Validate that either registrationId or (email + eventId) is provided
    if (!requestBody.registrationId && !(requestBody.email && requestBody.eventId)) {
      return {
        status: 400,
        jsonBody: {
          success: false,
          error: 'Either registrationId or (email and eventId) must be provided',
        },
      };
    }

    // Get Salesforce connection and Stripe client
    const crmConfig = getCrmConfig();
    const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
    const salesforceConnection = await crmService.connect();
    
    const stripeClient = stripeClientFactory.getClient(false);

    // Create event service
    const eventSvc = createEventSvc({
      salesforceConnection,
      stripeClient,
    });

    // Check in registrant
    const result = await eventSvc.checkInRegistrant(requestBody);

    if (!result.success) {
      return {
        status: 404,
        jsonBody: result,
      };
    }

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    context.error('Event check-in error:', error);

    return {
      status: 500,
      jsonBody: {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
    };
  }
}
