/**
 * Event Management Service
 * Handles event registration, check-in, and Salesforce integration
 */

import type { Connection } from 'jsforce/lib/connection';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import {
  Event,
  EventRegistration,
  EventRegistrationRequest,
  EventRegistrationResponse,
  EventCheckInRequest,
  EventCheckInResponse,
  RegistrantContact,
  ContactUpsertDTO,
  CampaignMemberDTO,
  EventType,
  RegistrationStatus,
  CheckInStatus,
  PaymentStatus,
} from '../types/events';

export interface EventSvcOptions {
  salesforceConnection: Connection;
  stripeClient: Stripe;
}

export interface EventSvc {
  registerForEvent: (request: EventRegistrationRequest, event: Event) => Promise<EventRegistrationResponse>;
  checkInRegistrant: (request: EventCheckInRequest) => Promise<EventCheckInResponse>;
  findOrCreateContact: (contact: RegistrantContact) => Promise<string>;
  addCampaignMember: (contactId: string, campaignId: string, status?: string) => Promise<string>;
  getActiveEvents: () => Promise<Event[]>;
}

// In-memory storage for registrations (in production, use a database)
const registrations: Map<string, EventRegistration> = new Map();

export const createEventSvc = ({ salesforceConnection, stripeClient }: EventSvcOptions): EventSvc => {
  /**
   * Find or create a contact in Salesforce
   */
  // simple cache stored in closure, reused across calls
  let cachedContactRecordTypeId: string | undefined;

  const findOrCreateContact = async (contact: RegistrantContact): Promise<string> => {
    const { email, firstName, lastName, phone, company, mailingStreet, mailingCity, mailingState, mailingPostalCode, mailingCountry } = contact;

    if (!email || !email.trim()) {
      throw new Error('Email is required for contact creation');
    }

    // Search for existing contact by email
    const escapedEmail = email.replace(/'/g, "\\'");
    const soql = `SELECT Id FROM Contact WHERE Email = '${escapedEmail}' LIMIT 1`;

    const result = await salesforceConnection.query<{ Id: string }>(soql);
    const records = Array.isArray(result.records) ? result.records : [];

    if (records.length > 0 && records[0].Id) {
      // Contact exists, return ID
      return records[0].Id;
    }

    // resolve record type id for new contact (cache if possible)
    if (!cachedContactRecordTypeId) {
      const recordTypeQuery = "SELECT Id FROM RecordType WHERE SObjectType = 'Contact' AND Name = 'Contact' LIMIT 1";
      const rtResult = await salesforceConnection.query<{ Id: string }>(recordTypeQuery);
      const rtRecords = Array.isArray(rtResult.records) ? rtResult.records : [];
      if (rtRecords.length > 0 && rtRecords[0].Id) {
        cachedContactRecordTypeId = rtRecords[0].Id;
      }
    }

    // Create new contact
    const contactData: ContactUpsertDTO = {
      Email: email,
      FirstName: firstName || undefined,
      LastName: lastName || 'Unknown',
      Phone: phone || undefined,
      Company: company || undefined,
      MailingStreet: mailingStreet || undefined,
      MailingCity: mailingCity || undefined,
      MailingState: mailingState || undefined,
      MailingPostalCode: mailingPostalCode || undefined,
      MailingCountry: mailingCountry || undefined,
      ...(cachedContactRecordTypeId ? { RecordTypeId: cachedContactRecordTypeId } : {}),
    };

    const createResult = await salesforceConnection.sobject('Contact').create(contactData);

    if (Array.isArray(createResult)) {
      const firstResult = createResult[0];
      if (!firstResult.success) {
        throw new Error(`Failed to create contact: ${firstResult.errors.join(', ')}`);
      }
      return firstResult.id;
    }

    if (!createResult.success) {
      throw new Error(`Failed to create contact: ${createResult.errors.join(', ')}`);
    }

    return createResult.id;
  };

  /**
   * Add contact as a campaign member
   */
  const addCampaignMember = async (
    contactId: string,
    campaignId: string,
    status: string = 'Registered'
  ): Promise<string> => {
    if (!contactId || !campaignId) {
      throw new Error('ContactId and CampaignId are required');
    }

    // Check if campaign member already exists
    const escapedContactId = contactId.replace(/'/g, "\\'");
    const escapedCampaignId = campaignId.replace(/'/g, "\\'");
    const soql = `SELECT Id FROM CampaignMember WHERE ContactId = '${escapedContactId}' AND CampaignId = '${escapedCampaignId}' LIMIT 1`;

    const result = await salesforceConnection.query<{ Id: string }>(soql);
    const records = Array.isArray(result.records) ? result.records : [];

    if (records.length > 0 && records[0].Id) {
      // Campaign member exists, return ID
      return records[0].Id;
    }

    // Create campaign member
    const campaignMemberData: CampaignMemberDTO = {
      CampaignId: campaignId,
      ContactId: contactId,
      Status: status,
    };

    const createResult = await salesforceConnection.sobject('CampaignMember').create(campaignMemberData);

    if (Array.isArray(createResult)) {
      const firstResult = createResult[0];
      if (!firstResult.success) {
        throw new Error(`Failed to add campaign member: ${firstResult.errors.join(', ')}`);
      }
      return firstResult.id;
    }

    if (!createResult.success) {
      throw new Error(`Failed to add campaign member: ${createResult.errors.join(', ')}`);
    }

    return createResult.id;
  };

  /**
   * Process payment for paid events
   */
  const processPayment = async (
    event: Event,
    contact: RegistrantContact,
    paymentMethodId?: string
  ): Promise<{
    paymentStatus: PaymentStatus;
    stripePaymentIntentId?: string;
    stripeSubscriptionId?: string;
    stripeCustomerId?: string;
    checkoutUrl?: string;
  }> => {
    if (event.type === 'free') {
      return { paymentStatus: PaymentStatus.NOT_REQUIRED };
    }

    if (!event.price || event.price <= 0) {
      throw new Error('Price is required for paid events');
    }

    // Create or retrieve Stripe customer
    const customerEmail = contact.email;
    const customerName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();

    let customer: Stripe.Customer;
    const existingCustomers = await stripeClient.customers.list({ email: customerEmail, limit: 1 });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripeClient.customers.create({
        email: customerEmail,
        name: customerName,
        phone: contact.phone,
        metadata: {
          eventId: event.id,
          eventName: event.name,
        },
      });
    }

    if (event.type === 'paid_recurring') {
      // Create subscription for recurring events
      if (!event.recurringInterval) {
        throw new Error('Recurring interval is required for recurring events');
      }

      const price = await stripeClient.prices.create({
        unit_amount: event.price,
        currency: event.currency || 'usd',
        recurring: {
          interval: event.recurringInterval,
          interval_count: 1,
        },
        product_data: {
          name: event.name,
        },
      });

      const subscription = await stripeClient.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
        metadata: {
          eventId: event.id,
          eventName: event.name,
        },
      });

      const invoice = subscription.latest_invoice as Stripe.Invoice;
      const paymentIntent = invoice?.payment_intent as Stripe.PaymentIntent;

      return {
        paymentStatus: PaymentStatus.PENDING,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: customer.id,
        stripePaymentIntentId: paymentIntent?.id,
      };
    } else {
      // Create one-time payment intent for paid_onetime events
      const paymentIntent = await stripeClient.paymentIntents.create({
        amount: event.price,
        currency: event.currency || 'usd',
        customer: customer.id,
        payment_method: paymentMethodId,
        confirm: !!paymentMethodId,
        metadata: {
          eventId: event.id,
          eventName: event.name,
          contactEmail: contact.email,
        },
        description: `Registration for ${event.name}`,
      });

      return {
        paymentStatus: paymentIntent.status === 'succeeded' ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
        stripePaymentIntentId: paymentIntent.id,
        stripeCustomerId: customer.id,
      };
    }
  };

  /**
   * Register a participant for an event
   */
  const registerForEvent = async (
    request: EventRegistrationRequest,
    event: Event
  ): Promise<EventRegistrationResponse> => {
    try {
      if (!event.isActive) {
        return {
          success: false,
          registrationId: '',
          eventId: event.id,
          registrationStatus: RegistrationStatus.FAILED,
          paymentStatus: PaymentStatus.FAILED,
          error: 'Event is not currently active',
        };
      }

      // Check capacity
      if (event.capacity) {
        const existingRegistrations = Array.from(registrations.values()).filter(
          (r) => r.eventId === event.id && r.registrationStatus === RegistrationStatus.CONFIRMED
        );
        if (existingRegistrations.length >= event.capacity) {
          return {
            success: false,
            registrationId: '',
            eventId: event.id,
            registrationStatus: RegistrationStatus.FAILED,
            paymentStatus: PaymentStatus.FAILED,
            error: 'Event is at full capacity',
          };
        }
      }

      // Find or create contact in Salesforce
      const contactId = await findOrCreateContact(request.contact);

      // Add to campaign
      const campaignMemberId = await addCampaignMember(contactId, event.campaignId);

      // Process payment if required
      const paymentResult = await processPayment(event, request.contact, request.paymentMethodId);

      // Create registration record
      const registrationId = randomUUID();
      const registration: EventRegistration = {
        id: registrationId,
        eventId: event.id,
        contact: request.contact,
        salesforceContactId: contactId,
        salesforceCampaignMemberId: campaignMemberId,
        registrationStatus: event.requiresApproval ? RegistrationStatus.PENDING : RegistrationStatus.CONFIRMED,
        checkInStatus: CheckInStatus.NOT_CHECKED_IN,
        paymentStatus: paymentResult.paymentStatus,
        stripeCustomerId: paymentResult.stripeCustomerId,
        stripePaymentIntentId: paymentResult.stripePaymentIntentId,
        stripeSubscriptionId: paymentResult.stripeSubscriptionId,
        amountPaid: event.price,
        currency: event.currency,
        registeredAt: new Date().toISOString(),
        notes: request.notes,
        customFields: request.customFields,
      };

      registrations.set(registrationId, registration);

      return {
        success: true,
        registrationId: registration.id,
        eventId: event.id,
        registrationStatus: registration.registrationStatus,
        paymentStatus: registration.paymentStatus,
        salesforceContactId: contactId,
        salesforceCampaignMemberId: campaignMemberId,
        stripeCheckoutSessionId: paymentResult.checkoutUrl,
        message: event.requiresApproval
          ? 'Registration submitted and pending approval'
          : 'Registration confirmed successfully',
      };
    } catch (error) {
      console.error('Event registration error:', error);
      return {
        success: false,
        registrationId: '',
        eventId: event.id,
        registrationStatus: RegistrationStatus.FAILED,
        paymentStatus: PaymentStatus.FAILED,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  };

  /**
   * Check in a registrant
   */
  const checkInRegistrant = async (request: EventCheckInRequest): Promise<EventCheckInResponse> => {
    try {
      let registration: EventRegistration | undefined;

      if (request.registrationId) {
        registration = registrations.get(request.registrationId);
      } else if (request.email && request.eventId) {
        // Find registration by email and event ID
        registration = Array.from(registrations.values()).find(
          (r) => r.contact.email.toLowerCase() === request.email!.toLowerCase() && r.eventId === request.eventId
        );
      }

      if (!registration) {
        return {
          success: false,
          registrationId: '',
          checkInStatus: CheckInStatus.NOT_CHECKED_IN,
          registrantName: '',
          error: 'Registration not found',
        };
      }

      if (registration.registrationStatus !== RegistrationStatus.CONFIRMED) {
        return {
          success: false,
          registrationId: registration.id,
          checkInStatus: CheckInStatus.NOT_CHECKED_IN,
          registrantName: `${registration.contact.firstName} ${registration.contact.lastName}`,
          error: 'Registration is not confirmed',
        };
      }

      if (registration.checkInStatus === CheckInStatus.CHECKED_IN) {
        return {
          success: true,
          registrationId: registration.id,
          checkInStatus: CheckInStatus.CHECKED_IN,
          checkedInAt: registration.checkedInAt,
          registrantName: `${registration.contact.firstName} ${registration.contact.lastName}`,
          message: 'Already checked in',
        };
      }

      // Update check-in status
      registration.checkInStatus = CheckInStatus.CHECKED_IN;
      registration.checkedInAt = new Date().toISOString();
      registrations.set(registration.id, registration);

      return {
        success: true,
        registrationId: registration.id,
        checkInStatus: CheckInStatus.CHECKED_IN,
        checkedInAt: registration.checkedInAt,
        registrantName: `${registration.contact.firstName} ${registration.contact.lastName}`,
        message: 'Check-in successful',
      };
    } catch (error) {
      console.error('Event check-in error:', error);
      return {
        success: false,
        registrationId: '',
        checkInStatus: CheckInStatus.NOT_CHECKED_IN,
        registrantName: '',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  };

  /**
   * Get all active events from Salesforce campaigns
   */
  const getActiveEvents = async (): Promise<Event[]> => {
    try {
      // Query active campaigns with Event record type
      const soql = `
        SELECT Id, Name, Description, StartDate, EndDate, IsActive,
               Event_Type__c, Price__c, Currency__c, Capacity__c,
               Recurring_Interval__c, Recurring_Count__c, Location__c,
               Requires_Approval__c
        FROM Campaign
        WHERE IsActive = true
        AND RecordType.Name = 'Event'
        ORDER BY StartDate ASC NULLS LAST
      `;

      const result = await salesforceConnection.query<{
        Id: string;
        Name: string;
        Description?: string;
        StartDate?: string;
        EndDate?: string;
        IsActive: boolean;
        Event_Type__c?: string;
        Price__c?: number;
        Currency__c?: string;
        Capacity__c?: number;
        Recurring_Interval__c?: string;
        Recurring_Count__c?: number;
        Location__c?: string;
        Requires_Approval__c?: boolean;
      }>(soql);

      const records = Array.isArray(result.records) ? result.records : [];

      return records.map(record => ({
        id: record.Id,
        name: record.Name,
        description: record.Description || '',
        type: (record.Event_Type__c as EventType) || EventType.FREE,
        campaignId: record.Id,
        startDate: record.StartDate || new Date().toISOString(),
        endDate: record.EndDate || new Date().toISOString(),
        location: record.Location__c,
        capacity: record.Capacity__c,
        price: record.Price__c,
        currency: record.Currency__c || 'USD',
        recurringInterval: record.Recurring_Interval__c as 'month' | 'year',
        recurringCount: record.Recurring_Count__c,
        requiresApproval: record.Requires_Approval__c || false,
        isActive: record.IsActive,
      }));
    } catch (error) {
      console.error('Error querying active events from Salesforce:', error);
      throw new Error('Failed to load events from Salesforce');
    }
  };

  return {
    registerForEvent,
    checkInRegistrant,
    findOrCreateContact,
    addCampaignMember,
    getActiveEvents,
  };
};
