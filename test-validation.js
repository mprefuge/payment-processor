const { z } = require('zod');

const FREQUENCY_VALUES = ['onetime', 'week', 'biweek', 'month', 'year'];

const frequencySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.enum(FREQUENCY_VALUES)
);

const amountSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return value;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return value;
    }

    return parsed;
  }

  return value;
}, z.number().int().positive());

const metadataSchema = z
  .preprocess((value) => {
    if (value === null || value === undefined) {
      return undefined;
    }

    return value;
  }, z.record(z.any()))
  .optional();

const addressSchema = z
  .object({
    line1: z.string().min(1).optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
  })
  .partial()
  .passthrough();

const legacyRequestSchema = z
  .object({
    amount: amountSchema,
    frequency: frequencySchema,
    email: z.string().email(),
    firstname: z.string().min(1),
    lastname: z.string().min(1),
    phone: z.string().optional(),
    address: z.union([addressSchema, z.string().min(1)]).optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipcode: z.string().optional(),
    postalCode: z.string().optional(),
    metadata: metadataSchema,
    attribution: z.string().optional(),
    coverFee: z.boolean().optional(),
    feeAmount: z.number().int().nonnegative().optional(),
    paymentMethod: z.enum(['card', 'card_present', 'us_bank_account', 'amex']).optional(),
    category: z.string().optional(),
    transactionType: z.string().optional(),
  })
  .passthrough();

const testPayload = {
  transactionType: "Donation",
  email: "customerTEST2@example.com",
  firstname: "Micah",
  lastname: "Testing",
  phone: "+1234567823",
  amount: 2520,
  frequency: "onetime",
  category: "General",
  coverFee: true,
  feeAmount: 220,
  address: {
    line1: "1234 Main St",
    city: "New York",
    state: "NY",
    postal_code: "10001",
    country: "US"
  }
};

console.log('Testing payload...');
const result = legacyRequestSchema.safeParse(testPayload);

if (result.success) {
  console.log('✅ Validation PASSED');
  console.log('Parsed data:', JSON.stringify(result.data, null, 2));
} else {
  console.log('❌ Validation FAILED');
  console.log('Errors:', result.error.issues);
}
