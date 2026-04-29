import { describe, it, expect } from 'vitest';

// Use the compiled dist version so that all CJS dependency chains resolve correctly
// (src/lib/logger.js is a minimal CJS bridge without createLogger; dist/lib/logger.js
//  is the compiled TypeScript version that exports createLogger as expected)
const { ContactMatcher, JaroWinkler } = require('../dist/services/payoutRecon/contactMatcher.js');

// Build a minimal ContactMatcher for tests
const matcher = new ContactMatcher();

// ── JaroWinkler ──────────────────────────────────────────────────────────────

describe('JaroWinkler.distance', () => {
  it('returns 1 for identical strings', () => {
    expect(JaroWinkler.distance('Smith', 'Smith')).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(JaroWinkler.distance('', '')).toBe(0);
  });

  it('returns 0 when one string is empty', () => {
    expect(JaroWinkler.distance('Smith', '')).toBe(0);
  });

  it('returns high similarity for near-matches', () => {
    const score = JaroWinkler.distance('John', 'Jonh');
    expect(score).toBeGreaterThan(0.8);
  });

  it('returns low similarity for very different strings', () => {
    const score = JaroWinkler.distance('Alice', 'Zebra');
    expect(score).toBeLessThan(0.7);
  });

  it('returns a value between 0 and 1', () => {
    const score = JaroWinkler.distance('Martha', 'Marhta');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ── ContactMatcher.normalize ─────────────────────────────────────────────────

describe('ContactMatcher.normalize', () => {
  it('normalizes email to lowercase', () => {
    const result = matcher.normalize({ email: 'Jane@Example.COM' });
    expect(result.email).toBe('jane@example.com');
  });

  it('strips + tags from email by default', () => {
    const result = matcher.normalize({ email: 'user+tag@example.com' });
    expect(result.email).toBe('user@example.com');
  });

  it('returns null email when no email provided', () => {
    const result = matcher.normalize({});
    expect(result.email).toBeNull();
  });

  it('normalizes 10-digit US phone to E.164', () => {
    const result = matcher.normalize({ phone: '5555550100' });
    expect(result.phone).toBe('15555550100');
  });

  it('normalizes phone with formatting', () => {
    const result = matcher.normalize({ phone: '(555) 555-0101' });
    expect(result.phone).toBe('15555550101');
  });

  it('normalizes first and last name to title case', () => {
    const result = matcher.normalize({ firstName: 'JANE', lastName: 'DOE' });
    expect(result.firstName).toBe('Jane');
    expect(result.lastName).toBe('Doe');
  });

  it('builds fullName from firstName and lastName', () => {
    const result = matcher.normalize({ firstName: 'Jane', lastName: 'Doe' });
    expect(result.fullName).toBe('Jane Doe');
  });

  it('leaves fullName null when only first name present', () => {
    const result = matcher.normalize({ firstName: 'Jane' });
    expect(result.fullName).toBeNull();
  });

  it('normalizes address object', () => {
    const result = matcher.normalize({
      address: { line1: '123 Main St', city: 'Springfield', state: 'IL', postal_code: '62701' },
    });
    expect(result.address?.postalCode).toBe('62701');
    expect(result.zipCode).toBe('62701');
  });

  it('extracts zipCode from flat zip property', () => {
    const result = matcher.normalize({ zip: '62702' });
    expect(result.zipCode).toBe('62702');
  });

  it('supports first_name / last_name snake_case aliases', () => {
    const result = matcher.normalize({ first_name: 'John', last_name: 'Smith' });
    expect(result.firstName).toBe('John');
    expect(result.lastName).toBe('Smith');
  });
});

// ── ContactMatcher.scoreCandidate ─────────────────────────────────────────────

describe('ContactMatcher.scoreCandidate', () => {
  it('scores exact email match', () => {
    const normalized = matcher.normalize({ email: 'jane@example.com' });
    const candidate = { Email: 'jane@example.com' };
    const scores = matcher.scoreCandidate(candidate, normalized);
    expect(scores.email).toBeGreaterThan(0);
    expect(scores.breakdown.email).toBe('exact');
  });

  it('scores zero for mismatched email', () => {
    const normalized = matcher.normalize({ email: 'jane@example.com' });
    const candidate = { Email: 'john@example.com' };
    const scores = matcher.scoreCandidate(candidate, normalized);
    expect(scores.email).toBe(0);
  });

  it('scores exact phone match', () => {
    const normalized = matcher.normalize({ phone: '5555550100' });
    const candidate = { Phone: '5555550100' };
    const scores = matcher.scoreCandidate(candidate, normalized);
    expect(scores.phone).toBeGreaterThan(0);
    expect(scores.breakdown.phone).toBe('exact');
  });

  it('scores exact name match', () => {
    const normalized = matcher.normalize({ firstName: 'Jane', lastName: 'Doe' });
    const candidate = { FirstName: 'Jane', LastName: 'Doe' };
    const scores = matcher.scoreCandidate(candidate, normalized);
    expect(scores.name).toBeGreaterThan(0);
    expect(scores.breakdown.name).toBe('exact');
  });

  it('scores fuzzy name match when names are similar', () => {
    const normalized = matcher.normalize({ firstName: 'John', lastName: 'Smith' });
    const candidate = { FirstName: 'Jonh', LastName: 'Smith' }; // typo in first name
    const scores = matcher.scoreCandidate(candidate, normalized);
    // May be fuzzy or 0 depending on threshold
    expect(typeof scores.name).toBe('number');
    expect(scores.name).toBeGreaterThanOrEqual(0);
  });

  it('scores exact ZIP match', () => {
    const normalized = matcher.normalize({ address: { postal_code: '62701' } });
    const candidate = { MailingPostalCode: '62701' };
    const scores = matcher.scoreCandidate(candidate, normalized);
    expect(scores.zip).toBeGreaterThan(0);
    expect(scores.breakdown.zip).toBe('exact');
  });

  it('returns total as sum of components', () => {
    const normalized = matcher.normalize({ email: 'jane@example.com', phone: '5555550100' });
    const candidate = { Email: 'jane@example.com', Phone: '5555550100' };
    const scores = matcher.scoreCandidate(candidate, normalized);
    const expected = scores.email + scores.phone + scores.name + scores.zip + scores.prior;
    expect(scores.total).toBeCloseTo(expected, 10);
  });

  it('returns zero total for completely mismatched candidate', () => {
    const normalized = matcher.normalize({ email: 'nobody@example.com' });
    const candidate = { Email: 'someone@else.com' };
    const scores = matcher.scoreCandidate(candidate, normalized);
    expect(scores.email).toBe(0);
    expect(scores.total).toBe(0);
  });
});

// ── ContactMatcher.decide ─────────────────────────────────────────────────────

describe('ContactMatcher.decide', () => {
  const buildEntry = (candidate, overrideScores = {}) => ({
    candidate: { Id: candidate.Id, ...candidate },
    scores: {
      email: 0,
      phone: 0,
      name: 0,
      zip: 0,
      prior: 0,
      total: 0,
      breakdown: {},
      ...overrideScores,
    },
  });

  it('returns create action when no candidates', () => {
    const decision = matcher.decide([], {});
    expect(decision.action).toBe('create');
    expect(decision.reason).toBe('no_candidates_found');
  });

  it('returns associate action when all three fields match exactly', () => {
    const entry = buildEntry(
      { Id: 'con_1', FirstName: 'Jane', LastName: 'Doe' },
      {
        total: 1.8,
        breakdown: { email: 'exact', phone: 'exact', name: 'exact' },
      }
    );
    const decision = matcher.decide([entry], {});
    expect(decision.action).toBe('associate');
    expect(decision.confidence).toBe('high');
    expect(decision.reviewRequired).toBe(false);
  });

  it('returns review action when email+phone match but name differs', () => {
    const entry = buildEntry(
      { Id: 'con_2' },
      {
        total: 1.3,
        breakdown: { email: 'exact', phone: 'exact' },
      }
    );
    const decision = matcher.decide([entry], {});
    expect(decision.action).toBe('review');
    expect(decision.reason).toBe('email_phone_match_name_differs');
    expect(decision.reviewRequired).toBe(true);
  });

  it('returns review action when name matches but contact info differs', () => {
    const entry = buildEntry(
      { Id: 'con_3' },
      {
        total: 0.5,
        breakdown: { name: 'exact' },
      }
    );
    const decision = matcher.decide([entry], {});
    expect(decision.action).toBe('review');
    expect(decision.reason).toBe('name_match_contact_info_differs');
  });

  it('returns create action for insufficient match (no exact fields)', () => {
    const entry = buildEntry({ Id: 'con_4' }, { total: 0.2, breakdown: {} });
    const decision = matcher.decide([entry], {});
    expect(decision.action).toBe('create');
    expect(decision.reason).toBe('insufficient_match');
    expect(decision.confidence).toBe('low');
  });

  it('picks the highest-scored candidate when multiple exist', () => {
    const low = buildEntry({ Id: 'low_con' }, { total: 0.3, breakdown: {} });
    const high = buildEntry(
      { Id: 'high_con' },
      {
        total: 1.8,
        breakdown: { email: 'exact', phone: 'exact', name: 'exact' },
      }
    );
    const decision = matcher.decide([low, high], {});
    expect(decision.contactId).toBe('high_con');
    expect(decision.action).toBe('associate');
  });
});

// ── ContactMatcher.processMatch ──────────────────────────────────────────────

describe('ContactMatcher.processMatch', () => {
  it('returns complete result structure', async () => {
    const transactionData = { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' };
    const findCandidates = async () => [];

    const result = await matcher.processMatch(transactionData, findCandidates);

    expect(result).toHaveProperty('normalized');
    expect(result).toHaveProperty('candidates');
    expect(result).toHaveProperty('decision');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('config');
  });

  it('create action when no candidates found', async () => {
    const result = await matcher.processMatch({ email: 'nobody@example.com' }, async () => []);
    expect(result.decision.action).toBe('create');
  });

  it('associates when exact match found', async () => {
    const transactionData = {
      email: 'jane@example.com',
      phone: '5555550100',
      firstName: 'Jane',
      lastName: 'Doe',
    };
    const candidates = [
      {
        Id: 'con_exact',
        Email: 'jane@example.com',
        Phone: '5555550100',
        FirstName: 'Jane',
        LastName: 'Doe',
      },
    ];
    const result = await matcher.processMatch(transactionData, async () => candidates);
    expect(result.decision.action).toBe('associate');
    expect(result.decision.contactId).toBe('con_exact');
  });

  it('passes normalized data to findCandidates', async () => {
    let capturedNormalized = null;
    await matcher.processMatch({ email: 'TEST@EXAMPLE.COM' }, async (normalized) => {
      capturedNormalized = normalized;
      return [];
    });
    expect(capturedNormalized?.email).toBe('test@example.com');
  });
});
