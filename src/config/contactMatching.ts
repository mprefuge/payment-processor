export interface ContactMatchWeights {
  emailExact: number;
  phoneExact: number;
  nameExact: number;
  nameFuzzy: number;
  zipExact: number;
  priorTransaction: number;
}

export interface ContactMatchThresholds {
  high: number;
  low: number;
}

export interface ContactMatchNormalization {
  email: {
    stripPlusTags: boolean;
  };
  phone: {
    defaultCountryCode: string;
  };
  name: {
    fuzzyThreshold: number;
  };
}

export interface ContactMatchTransactionSettings {
  nameTemplate: string;
  defaultCategory: string;
}

export interface ContactMatchReviewSettings {
  enabled: boolean;
  taskSubjectPrefix: string;
  deepLinkBaseUrl: string;
}

export interface ContactMatchLoggingSettings {
  level: string;
  redactPII: boolean;
  structured: boolean;
}

export interface ContactMatchPerformanceSettings {
  maxCandidates: number;
  searchTimeout: number;
}

export interface ContactMatchConfig {
  weights: ContactMatchWeights;
  thresholds: ContactMatchThresholds;
  normalization: ContactMatchNormalization;
  transaction: ContactMatchTransactionSettings;
  review: ContactMatchReviewSettings;
  logging: ContactMatchLoggingSettings;
  performance: ContactMatchPerformanceSettings;
}

export interface TransactionMetadata {
  amount?: string;
  date?: string;
  id?: string;
}

export function loadConfig(): ContactMatchConfig {
  return {
    weights: {
      emailExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_EMAIL_EXACT ?? '') || 0.7,
      phoneExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_PHONE_EXACT ?? '') || 0.6,
      nameExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_NAME_EXACT ?? '') || 0.5,
      nameFuzzy: parseFloat(process.env.CONTACT_MATCH_WEIGHT_NAME_FUZZY ?? '') || 0.35,
      zipExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_ZIP_EXACT ?? '') || 0.2,
      priorTransaction: parseFloat(process.env.CONTACT_MATCH_WEIGHT_PRIOR_TRANSACTION ?? '') || 0.2,
    },
    thresholds: {
      high: parseFloat(process.env.CONTACT_MATCH_THRESHOLD_HIGH ?? '') || 0.9,
      low: parseFloat(process.env.CONTACT_MATCH_THRESHOLD_LOW ?? '') || 0.6,
    },
    normalization: {
      email: {
        stripPlusTags: process.env.CONTACT_MATCH_EMAIL_STRIP_PLUS_TAGS !== 'false',
      },
      phone: {
        defaultCountryCode: process.env.CONTACT_MATCH_DEFAULT_COUNTRY_CODE || 'US',
      },
      name: {
        fuzzyThreshold: parseFloat(process.env.CONTACT_MATCH_NAME_FUZZY_THRESHOLD ?? '') || 0.8,
      },
    },
    transaction: {
      nameTemplate: process.env.TRANSACTION_NAME_TEMPLATE || 'Transaction - {category}',
      defaultCategory: process.env.TRANSACTION_DEFAULT_CATEGORY || 'Uncategorized',
    },
    review: {
      enabled: process.env.CONTACT_MATCH_REVIEW_ENABLED !== 'false',
      taskSubjectPrefix: process.env.REVIEW_TASK_SUBJECT_PREFIX || 'Manual Review Required: ',
      deepLinkBaseUrl: process.env.REVIEW_DEEP_LINK_BASE_URL || 'https://example.com/admin',
    },
    logging: {
      level: process.env.CONTACT_MATCH_LOG_LEVEL || 'info',
      redactPII: process.env.CONTACT_MATCH_REDACT_PII !== 'false',
      structured: process.env.CONTACT_MATCH_STRUCTURED_LOGS !== 'false',
    },
    performance: {
      maxCandidates: parseInt(process.env.CONTACT_MATCH_MAX_CANDIDATES ?? '', 10) || 10,
      searchTimeout: parseInt(process.env.CONTACT_MATCH_SEARCH_TIMEOUT_MS ?? '', 10) || 30000,
    },
  };
}

export function validateConfig(config: ContactMatchConfig): true {
  const errors: string[] = [];

  if (config.thresholds.high <= config.thresholds.low) {
    errors.push('High threshold must be greater than low threshold');
  }

  if (config.thresholds.high > 1.0 || config.thresholds.low < 0) {
    errors.push('Thresholds must be between 0 and 1');
  }

  const totalMaxWeight = Object.values(config.weights).reduce((sum, weight) => sum + weight, 0);
  if (totalMaxWeight < config.thresholds.high) {
    console.warn(
      `Warning: Maximum possible score (${totalMaxWeight}) is less than high threshold (${config.thresholds.high})`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
  }

  return true;
}

export function normalizeTransactionCategory(inputCategory: string | undefined | null, config: ContactMatchConfig): string {
  if (!inputCategory) {
    return config.transaction.defaultCategory;
  }

  return inputCategory
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function generateTransactionName(
  category: string,
  config: ContactMatchConfig,
  metadata: TransactionMetadata = {},
): string {
  let name = config.transaction.nameTemplate;

  name = name.replace('{category}', category);
  name = name.replace('{amount}', metadata.amount || '');
  name = name.replace('{date}', metadata.date || '');
  name = name.replace('{id}', metadata.id || '');

  return name;
}
