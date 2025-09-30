# ADR 001: Pledge CRM Integration Architecture

## Status
Accepted

## Context
We need to implement a Pledges feature that allows creation and management of pledges (commitments to give a total amount over time), with installment schedules, automated payment matching, and full CRM integration. The CRM (Salesforce) already has a Transaction__c object for recording payment events.

We must decide how to model pledges in the CRM:
- **Option A**: Create new custom objects (Pledge__c, PledgeInstallment__c, PledgePaymentAllocation__c) linked to Transaction__c
- **Option B**: Extend the existing Transaction__c object with pledge-related fields

## Decision
We will implement **Option A: New CRM Objects** for the following reasons:

### Data Model
1. **Pledge__c** - Master pledge record
   - Contact__c (lookup to Contact)
   - Fund_Category__c (text/picklist)
   - Total_Amount__c (currency)
   - Currency__c (text)
   - Balance_Remaining__c (currency, formula or calculated)
   - Start_Date__c (date)
   - Schedule_Type__c (picklist: Monthly, Quarterly, Custom)
   - Number_of_Installments__c (number)
   - Status__c (picklist: Active, Fulfilled, Canceled, Written-Off, Paused)
   - Notes__c (long text)
   - Created_Date__c, Last_Modified_Date__c (audit)

2. **PledgeInstallment__c** - Individual installment records
   - Pledge__c (master-detail to Pledge__c)
   - Sequence_Number__c (number)
   - Due_Date__c (date)
   - Amount_Due__c (currency)
   - Amount_Paid__c (currency, rollup or calculated)
   - Balance_Remaining__c (formula: Amount_Due__c - Amount_Paid__c)
   - Status__c (formula/workflow: Unpaid, Partial, Paid, Overdue)
   - Notes__c (text)

3. **PledgePaymentAllocation__c** - Junction object linking transactions to installments
   - Transaction__c (lookup to Transaction__c)
   - Pledge__c (lookup to Pledge__c)
   - PledgeInstallment__c (lookup to PledgeInstallment__c)
   - Amount_Applied__c (currency)
   - Allocation_Date__c (datetime)
   - Applied_By__c (lookup to User, for manual allocations)
   - Is_Automatic__c (checkbox)

4. **Transaction__c** - Extended with pledge reference
   - Pledge__c (lookup to Pledge__c) - optional, only for pledge payments
   - Is_Pledge_Payment__c (formula: NOT(ISBLANK(Pledge__c)))

### Rationale

**Why Option A over Option B:**

1. **Separation of Concerns**: Pledges are conceptually different from transactions:
   - Pledges are commitments/promises (future-oriented)
   - Transactions are actual payments (historical events)
   - Mixing them in one object violates single responsibility principle

2. **Data Integrity**: 
   - One pledge has many installments - proper master-detail relationship
   - One transaction can partially pay multiple installments - requires junction object
   - Many-to-many relationship between transactions and installments is cleanly handled
   - Prevents data denormalization issues

3. **Reporting and Analytics**:
   - Clean separation allows independent reporting on pledges vs transactions
   - Rollup summaries work naturally (total paid per pledge, total allocated per transaction)
   - No risk of breaking existing transaction reports
   - Easy to query "all pledges for contact" vs "all transactions for contact"

4. **Flexibility**:
   - Can extend pledge functionality without touching transaction object
   - Can add pledge-specific workflows, validation rules, automations
   - Can handle complex scenarios (pledge transfers, consolidations, splits)

5. **CRM Best Practices**:
   - Salesforce data modeling best practices favor dedicated objects for distinct entities
   - Master-detail relationships provide automatic rollups and security
   - Junction objects are the standard pattern for many-to-many relationships

6. **Backward Compatibility**:
   - Zero impact on existing Transaction__c functionality
   - Existing reports, dashboards, and integrations continue to work
   - Pledge fields on Transaction__c are optional and non-intrusive

### Allocation Model

**FIFO (First-In-First-Out) with Split Support**:
- Payments apply to earliest unpaid installment first
- If payment exceeds installment balance, remainder applies to next installment
- Continue until payment is fully allocated or all installments are paid
- Overpayments handled per configuration (see Prepayment Policy)

**Allocation Process**:
1. Match transaction to pledge (see Matching Strategy)
2. Retrieve unpaid/partial installments ordered by due_date ASC
3. Apply payment amount to each installment in sequence
4. Create PledgePaymentAllocation__c record for each installment receiving payment
5. Update installment Amount_Paid__c (via rollup or manual calculation)
6. Update pledge Balance_Remaining__c
7. Update installment/pledge status as needed

**Idempotency**: 
- Use unique constraint on (Transaction__c, PledgeInstallment__c) to prevent double allocation
- Store allocation records even for $0 amounts to track decision history

### Prepayment Policy

**Default: Apply to Pledge Balance Only**
- Payment applies only up to remaining pledge balance
- Excess becomes a regular (non-pledge) transaction or credit
- Configurable via `PLEDGE_PREPAYMENT_POLICY=balance_only` (default)

**Alternative: Prepay Future Installments**
- Payment can exceed current installment, prepaying future installments
- Allows donors to pay ahead of schedule
- Configurable via `PLEDGE_PREPAYMENT_POLICY=prepay_future`
- Still respects total pledge amount (won't allocate beyond pledge balance)

**Underpayment**:
- Installment marked as "Partial" with remaining balance tracked
- Next payment continues FIFO (applies to partially paid installment first)
- No penalties or special handling for partial payments

### Matching Strategy

**Confidence-Based Matching** (similar to existing ContactMatcher):

**Signals and Weights** (configurable):
- Explicit pledge_id in transaction metadata: 0.8
- Category/fund alignment: 0.3
- Due date proximity (within window): 0.3
- Amount fit vs remaining balance (within tolerance): 0.3
- Memo/reference pattern match: 0.2
- Prior linkage history (same payment method paid this pledge): 0.2

**Decision Thresholds**:
- `PLEDGE_MATCH_THRESHOLD_HIGH` (default 0.90): Auto-apply to pledge
- `PLEDGE_MATCH_THRESHOLD_LOW` (default 0.60): Needs manual review
- Below low threshold: Treat as non-pledge transaction, flag for review

**Candidate Selection**:
1. Get all active pledges for matched contact
2. Optionally include household/account pledges
3. Score each pledge based on signals
4. Select best match if score ≥ threshold

**Review Workflow**:
- Create review task in CRM for medium/low confidence matches
- Include transaction details, candidate pledges with scores, decision context
- Provide deep links to CRM records
- Manual resolution updates allocation and clears review flag

## Consequences

### Positive
- Clean data model following CRM best practices
- No impact on existing transaction functionality
- Flexible and extensible for future requirements
- Proper many-to-many relationship modeling
- Easy to query and report on pledges independently
- Automated rollups and calculations via platform features

### Negative
- Requires creating 3 new custom objects in Salesforce
- More complex data model (but properly normalized)
- Need to manage relationships across multiple objects
- Slightly more API calls for pledge operations (mitigated by bulk operations)

### Mitigation
- Provide clear documentation and migration scripts for CRM setup
- Use bulk operations to minimize API calls
- Implement caching where appropriate
- Create helper methods to abstract complexity

## Implementation Notes

1. **CRM Setup**: Provide Salesforce metadata package or manual setup guide
2. **Migration**: Existing transactions are unaffected; pledges are net-new functionality
3. **Reconciliation**: Background job to verify allocation totals match balances
4. **Performance**: Use SOQL best practices, bulkify operations, consider caching pledge data
5. **Security**: Leverage Salesforce sharing model; pledges inherit contact security

## References
- Salesforce Data Modeling Best Practices
- CRM Integration Requirements (problem statement)
- Existing ContactMatcher implementation (services/contactMatcher.js)
