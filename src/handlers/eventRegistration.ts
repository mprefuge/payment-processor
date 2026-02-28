/**
 * Event Registration HTTP Handler
 * Handles event registration requests
 */

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createEventSvc } from '../services/eventSvc';
import type { EventRegistrationRequest, Event } from '../types/events';
import { stripeClientFactory } from '../services/stripeClientFactory';
import env from '../config/env';
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

export default async function eventRegistration(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Event registration request received');

  try {
    // Parse request body
    const requestBody = (await request.json()) as EventRegistrationRequest;

    if (!requestBody || !requestBody.eventId || !requestBody.contact) {
      return {
        status: 400,
        jsonBody: {
          success: false,
          error: 'Missing required fields: eventId and contact are required',
        },
      };
    }

    // Validate contact data
    const { contact } = requestBody;
    if (!contact.email || !contact.firstName || !contact.lastName) {
      return {
        status: 400,
        jsonBody: {
          success: false,
          error: 'Contact must include email, firstName, and lastName',
        },
      };
    }

    // Get Salesforce connection first to query for events
    const crmConfig = getCrmConfig();
    const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
    const salesforceConnection = await crmService.connect();

    // Create event service to query for active events
    const stripeClient = stripeClientFactory.getClient(!env.testMode);
    const eventSvc = createEventSvc({
      salesforceConnection,
      stripeClient,
    });

    // Get all active events and find the requested one
    const activeEvents = await eventSvc.getActiveEvents();
    const event = activeEvents.find((e: Event) => e.id === requestBody.eventId);

    if (!event) {
      return {
        status: 404,
        jsonBody: {
          success: false,
          error: `Event not found: ${requestBody.eventId}`,
        },
      };
    }

    // Register for event
    const result = await eventSvc.registerForEvent(requestBody, event);

    if (!result.success) {
      return {
        status: 400,
        jsonBody: result,
      };
    }

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    context.error('Event registration error:', error);

    return {
      status: 500,
      jsonBody: {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
    };
  }
}
