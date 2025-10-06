import { z } from "zod";

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value: unknown) => {
    if (value === undefined || value === "") {
      return defaultValue;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }

    if (typeof value === "boolean") {
      return value;
    }

    return value;
  }, z.boolean());

export const envSchema = z
  .object({
    STRIPE_SECRET: z.string().min(1, "STRIPE_SECRET is required"),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .min(1, "STRIPE_WEBHOOK_SECRET is required"),
    SF_CLIENT_ID: z.string().min(1, "SF_CLIENT_ID is required"),
    SF_CLIENT_SECRET: z.string().min(1, "SF_CLIENT_SECRET is required"),
    SF_USERNAME: z.string().min(1, "SF_USERNAME is required"),
    SF_PASSWORD: z.string().min(1, "SF_PASSWORD is required"),
    QBO_CLIENT_ID: z.string().min(1, "QBO_CLIENT_ID is required"),
    QBO_CLIENT_SECRET: z
      .string()
      .min(1, "QBO_CLIENT_SECRET is required"),
    QBO_ENV: z.enum(["sandbox", "prod"]),
    QBO_REALM_ID: z.string().min(1, "QBO_REALM_ID is required"),
    ENABLE_SF: booleanFromEnv(true),
    ENABLE_QBO: booleanFromEnv(true),
    QBO_FEES_AGGREGATION: z.enum(["per_tx", "daily"]).default("per_tx"),
    DOCNUM_PREFIX: z.string().min(1).default("stripe"),
    SF_USE_NPSP: booleanFromEnv(false),
    QBO_ACCOUNT_STRIPE_CLEARING: z
      .string()
      .min(1, "QBO_ACCOUNT_STRIPE_CLEARING is required"),
    QBO_ACCOUNT_CHECKING: z
      .string()
      .min(1, "QBO_ACCOUNT_CHECKING is required"),
    QBO_ACCOUNT_STRIPE_FEES: z
      .string()
      .min(1, "QBO_ACCOUNT_STRIPE_FEES is required"),
    QBO_ITEM_DONATION: z.string().min(1, "QBO_ITEM_DONATION is required"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    AZURE_STORAGE_CONNECTION_STRING: z
      .string()
      .min(1, "AZURE_STORAGE_CONNECTION_STRING is required"),
  })
  .passthrough();

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super("Invalid environment configuration");
  }
}

let cachedEnv: Env | null = null;

export const getEnv = (overrides?: NodeJS.ProcessEnv): Env => {
  const source = { ...process.env, ...overrides };
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }

  if (!overrides) {
    cachedEnv = result.data;
  }

  return result.data;
};

export const getCachedEnv = (): Env => {
  if (!cachedEnv) {
    cachedEnv = getEnv();
  }

  return cachedEnv;
};
