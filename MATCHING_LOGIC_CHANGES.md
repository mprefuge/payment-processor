# Matching Logic Changes

## Summary

Updated the contact matching logic to require exact matches on email, phone, AND name for a record to be updated. This prevents accidental data overwrites and ensures that review tasks are only created when necessary.

## Changes Made

### 1. Updated `services/contactMatcher.js`

**Changed the `decide()` method** to implement the new matching rules:

- **Rule 1**: Email + Phone + Name all match exactly → **Associate** (update existing contact)
- **Rule 2**: Email + Phone match, but Name differs → **Review** (create review task + new contact)
- **Rule 3**: Name matches, but Email or Phone differ → **Review** (create review task + new contact)
- **Rule 4**: Otherwise → **Create** (create new contact without review)

**Key differences from old behavior:**
- Old: Used threshold-based scoring (0.90+ = associate, 0.60-0.89 = review, <0.60 = review)
- New: Requires exact matches on all three fields for association

### 2. Updated `stripeWebhook/index.js`

**Changed the webhook handler** to handle the new 'create' action:

- When `action === 'associate'`: Update existing contact (unchanged)
- When `action === 'review'`: Create review task AND create new contact (changed from using existing contact)
- When `action === 'create'`: Create new contact without review (new behavior)

**Key differences from old behavior:**
- Old: For review cases, would use the best candidate contact and update it
- New: For review cases, creates a new contact to prevent data overwrite

### 3. Updated Tests

**Updated `tests/contactMatcher.test.js`:**
- Changed decision-making tests to use exact match logic instead of threshold-based scoring
- Added `breakdown` fields to test data to support new matching logic

**Created `tests/matchingLogic.test.js`:**
- Comprehensive tests for all 4 matching rules
- Tests for edge cases (only email matches, only phone matches, etc.)
- All 8 tests pass

### 4. Created Demonstration

**Created `examples/matching-logic-demo.js`:**
- Shows 7 real-world scenarios demonstrating the new behavior
- Clearly shows when each action (associate, review, create) is triggered
- Helps validate the implementation

## Test Results

All tests pass:
- ✅ `contactMatcher.test.js`: 17/17 tests passed
- ✅ `matchingLogic.test.js`: 8/8 tests passed  
- ✅ `nameValidation.test.js`: 8/8 tests passed
- ✅ `integration-name-validation.test.js`: All tests passed
- ✅ `integration.test.js`: 14/14 tests passed

## Benefits

1. **Prevents Data Corruption**: Ensures existing contact data isn't accidentally overwritten when names don't match
2. **Targeted Review Tasks**: Only creates review tasks when truly ambiguous (partial matches)
3. **Reduced Manual Work**: No review needed for clear cases (no match or insufficient match)
4. **Data Integrity**: Maintains accurate contact records by requiring all three fields to match

## Scenarios

### Scenario 1: All Fields Match Exactly
- Transaction: John Doe, john.doe@example.com, 555-123-4567
- Existing: John Doe, john.doe@example.com, 555-123-4567
- **Result**: ✅ Update existing contact

### Scenario 2: Email+Phone Match, Name Differs
- Transaction: Johnny Doe, john.doe@example.com, 555-123-4567
- Existing: John Doe, john.doe@example.com, 555-123-4567
- **Result**: ⚠️ Create review task + Create new contact

### Scenario 3: Name Matches, Email Differs
- Transaction: John Doe, john.new@example.com, 555-123-4567
- Existing: John Doe, john.doe@example.com, 555-123-4567
- **Result**: ⚠️ Create review task + Create new contact

### Scenario 4: Name Matches, Phone Differs
- Transaction: John Doe, john.doe@example.com, 555-999-9999
- Existing: John Doe, john.doe@example.com, 555-123-4567
- **Result**: ⚠️ Create review task + Create new contact

### Scenario 5: Only Email Matches
- Transaction: Bob Johnson, john.doe@example.com, 555-888-8888
- Existing: John Doe, john.doe@example.com, 555-123-4567
- **Result**: ➕ Create new contact (no review)

### Scenario 6: Only Phone Matches
- Transaction: Bob Johnson, bob.johnson@example.com, 555-123-4567
- Existing: John Doe, john.doe@example.com, 555-123-4567
- **Result**: ➕ Create new contact (no review)

### Scenario 7: No Matches
- Transaction: Alice Williams, alice.williams@example.com, 555-777-7777
- Existing: John Doe, john.doe@example.com, 555-123-4567
- **Result**: ➕ Create new contact (no review)

## Backward Compatibility

The changes modify core matching logic, which may affect existing workflows:

- ✅ All existing tests have been updated and pass
- ✅ The scoring system remains intact for potential future use
- ⚠️ Review tasks will now be created less frequently (only for partial matches)
- ⚠️ More new contacts may be created instead of updating existing ones

## Configuration

The new logic doesn't rely on the threshold configuration anymore, but the thresholds remain in the config for backward compatibility and potential future use. The exact match logic is now deterministic and doesn't use configurable thresholds.
