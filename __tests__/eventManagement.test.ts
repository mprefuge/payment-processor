/**
 * Event Management Tests
 * Tests for event registration, check-in, and Salesforce integration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventSvc } from '../src/services/eventSvc';
import type {
  Event,
  EventType,
  EventRegistrationRequest,
  EventCheckInRequest,
  RegistrantContact,
} from '../src/types/events';

// Mock Salesforce connection
const mockSalesforceConnection = {
  query: vi.fn(),
  sobject: vi.fn(() => ({
    create: vi.fn(),
  })),
};

// Mock Stripe client
const mockStripeClient: any = {
  customers: {
    list: vi.fn(),
    create: vi.fn(),
  },
  paymentIntents: {
    create: vi.fn(),
  },
  prices: {
    create: vi.fn(),
  },
  subscriptions: {
    create: vi.fn(),
  },
};

describe('Event Management Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Contact Management', () => {
    it('should find existing contact by email', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      mockSalesforceConnection.query.mockResolvedValue({
        records: [{ Id: 'contact123' }],
      });

      const contact: RegistrantContact = {
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
      };

      const contactId = await eventSvc.findOrCreateContact(contact);

      expect(contactId).toBe('contact123');
      expect(mockSalesforceConnection.query).toHaveBeenCalledWith(
        expect.stringContaining("Email = 'test@example.com'")
      );
    });

    it('should create new contact if not found', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      mockSalesforceConnection.query.mockResolvedValue({
        records: [],
      });

      mockSalesforceConnection.sobject.mockReturnValue({
        create: vi.fn().mockResolvedValue({
          success: true,
          id: 'newContact123',
        }),
      });

      const contact: RegistrantContact = {
        email: 'new@example.com',
        firstName: 'Jane',
        lastName: 'Smith',
      };

      const contactId = await eventSvc.findOrCreateContact(contact);

      expect(contactId).toBe('newContact123');
      expect(mockSalesforceConnection.sobject).toHaveBeenCalledWith('Contact');
    });
  });

  describe('Campaign Member Management', () => {
    it('should return existing campaign member if found', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      mockSalesforceConnection.query.mockResolvedValue({
        records: [{ Id: 'campaignMember123' }],
      });

      const memberId = await eventSvc.addCampaignMember('contact123', 'campaign123');

      expect(memberId).toBe('campaignMember123');
    });

    it('should create new campaign member if not found', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      mockSalesforceConnection.query.mockResolvedValue({
        records: [],
      });

      mockSalesforceConnection.sobject.mockReturnValue({
        create: vi.fn().mockResolvedValue({
          success: true,
          id: 'newCampaignMember123',
        }),
      });

      const memberId = await eventSvc.addCampaignMember('contact123', 'campaign123', 'Registered');

      expect(memberId).toBe('newCampaignMember123');
    });
  });

  describe('Event Registration', () => {
    it('should successfully register for a free event', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      mockSalesforceConnection.query.mockResolvedValue({
        records: [{ Id: 'contact123' }],
      });

      mockSalesforceConnection.sobject.mockReturnValue({
        create: vi.fn().mockResolvedValue({
          success: true,
          id: 'campaignMember123',
        }),
      });

      const event: Event = {
        id: 'free-event-1',
        name: 'Free Webinar',
        description: 'Educational webinar',
        type: 'free' as EventType,
        campaignId: 'campaign123',
        startDate: '2025-12-01T10:00:00Z',
        endDate: '2025-12-01T11:00:00Z',
        isActive: true,
      };

      const request: EventRegistrationRequest = {
        eventId: 'free-event-1',
        contact: {
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        },
      };

      const result = await eventSvc.registerForEvent(request, event);

      expect(result.success).toBe(true);
      expect(result.registrationStatus).toBe('confirmed');
      expect(result.paymentStatus).toBe('not_required');
      expect(result.salesforceContactId).toBe('contact123');
    });

    it('should reject registration for inactive event', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      const event: Event = {
        id: 'inactive-event',
        name: 'Inactive Event',
        description: 'This event is not active',
        type: 'free' as EventType,
        campaignId: 'campaign123',
        startDate: '2025-12-01T10:00:00Z',
        endDate: '2025-12-01T11:00:00Z',
        isActive: false,
      };

      const request: EventRegistrationRequest = {
        eventId: 'inactive-event',
        contact: {
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        },
      };

      const result = await eventSvc.registerForEvent(request, event);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not currently active');
    });

    it('should handle paid event registration with Stripe', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      mockSalesforceConnection.query.mockResolvedValue({
        records: [{ Id: 'contact123' }],
      });

      mockSalesforceConnection.sobject.mockReturnValue({
        create: vi.fn().mockResolvedValue({
          success: true,
          id: 'campaignMember123',
        }),
      });

      mockStripeClient.customers.list.mockResolvedValue({
        data: [],
      });

      mockStripeClient.customers.create.mockResolvedValue({
        id: 'cus_123',
      });

      mockStripeClient.paymentIntents.create.mockResolvedValue({
        id: 'pi_123',
        status: 'succeeded',
      });

      const event: Event = {
        id: 'paid-event-1',
        name: 'Paid Conference',
        description: 'Premium conference',
        type: 'paid_onetime' as EventType,
        campaignId: 'campaign123',
        startDate: '2025-12-01T10:00:00Z',
        endDate: '2025-12-01T11:00:00Z',
        price: 15000, // $150.00
        currency: 'USD',
        isActive: true,
      };

      const request: EventRegistrationRequest = {
        eventId: 'paid-event-1',
        contact: {
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        },
        paymentMethodId: 'pm_123',
      };

      const result = await eventSvc.registerForEvent(request, event);

      expect(result.success).toBe(true);
      expect(result.paymentStatus).toBe('completed');
      expect(mockStripeClient.customers.create).toHaveBeenCalled();
      expect(mockStripeClient.paymentIntents.create).toHaveBeenCalled();
    });
  });

  describe('Event Check-In', () => {
    it('should successfully check in a registrant by registration ID', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      // First, register for an event
      mockSalesforceConnection.query.mockResolvedValue({
        records: [{ Id: 'contact123' }],
      });

      mockSalesforceConnection.sobject.mockReturnValue({
        create: vi.fn().mockResolvedValue({
          success: true,
          id: 'campaignMember123',
        }),
      });

      const event: Event = {
        id: 'event-1',
        name: 'Test Event',
        description: 'Test',
        type: 'free' as EventType,
        campaignId: 'campaign123',
        startDate: '2025-12-01T10:00:00Z',
        endDate: '2025-12-01T11:00:00Z',
        isActive: true,
      };

      const registrationRequest: EventRegistrationRequest = {
        eventId: 'event-1',
        contact: {
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        },
      };

      const registrationResult = await eventSvc.registerForEvent(registrationRequest, event);

      // Now check in
      const checkInRequest: EventCheckInRequest = {
        registrationId: registrationResult.registrationId,
      };

      const checkInResult = await eventSvc.checkInRegistrant(checkInRequest);

      expect(checkInResult.success).toBe(true);
      expect(checkInResult.checkInStatus).toBe('checked_in');
      expect(checkInResult.checkedInAt).toBeDefined();
      expect(checkInResult.registrantName).toBe('John Doe');
    });

    it('should handle duplicate check-in gracefully', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      // Register for an event
      mockSalesforceConnection.query.mockResolvedValue({
        records: [{ Id: 'contact123' }],
      });

      mockSalesforceConnection.sobject.mockReturnValue({
        create: vi.fn().mockResolvedValue({
          success: true,
          id: 'campaignMember123',
        }),
      });

      const event: Event = {
        id: 'event-1',
        name: 'Test Event',
        description: 'Test',
        type: 'free' as EventType,
        campaignId: 'campaign123',
        startDate: '2025-12-01T10:00:00Z',
        endDate: '2025-12-01T11:00:00Z',
        isActive: true,
      };

      const registrationRequest: EventRegistrationRequest = {
        eventId: 'event-1',
        contact: {
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        },
      };

      const registrationResult = await eventSvc.registerForEvent(registrationRequest, event);

      // Check in first time
      const checkInRequest: EventCheckInRequest = {
        registrationId: registrationResult.registrationId,
      };

      await eventSvc.checkInRegistrant(checkInRequest);

      // Check in second time
      const checkInResult2 = await eventSvc.checkInRegistrant(checkInRequest);

      expect(checkInResult2.success).toBe(true);
      expect(checkInResult2.message).toContain('Already checked in');
    });

    it('should return error for non-existent registration', async () => {
      const eventSvc = createEventSvc({
        salesforceConnection: mockSalesforceConnection as any,
        stripeClient: mockStripeClient,
      });

      const checkInRequest: EventCheckInRequest = {
        registrationId: 'non-existent-id',
      };

      const result = await eventSvc.checkInRegistrant(checkInRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
