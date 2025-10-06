import fs from "fs";
import path from "path";
import { z } from "zod";

interface CliOptions {
  logInputs: string[];
  payoutInputs: string[];
  days: number;
}

const SUPPORTED_LOG_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".ndjson",
  ".log",
  ".txt",
]);

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    logInputs: [],
    payoutInputs: [],
    days: 7,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    switch (value) {
      case "--log":
      case "--logs": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error(`${value} requires a path argument`);
        }
        options.logInputs.push(next);
        index += 1;
        break;
      }
      case "--payouts":
      case "--metrics": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error(`${value} requires a path argument`);
        }
        options.payoutInputs.push(next);
        index += 1;
        break;
      }
      case "--days": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error("--days requires a numeric argument");
        }
        const parsed = Number(next);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid day window: ${next}`);
        }
        options.days = parsed;
        index += 1;
        break;
      }
      default: {
        if (value.startsWith("-")) {
          throw new Error(`Unknown argument: ${value}`);
        }
      }
    }
  }

  if (options.logInputs.length === 0) {
    const defaultLogsPath = path.join(process.cwd(), "observability", "logs");
    if (fs.existsSync(defaultLogsPath)) {
      options.logInputs.push(defaultLogsPath);
    }
  }

  if (options.logInputs.length === 0) {
    throw new Error("At least one --log path must be provided or an observability/logs directory must exist");
  }

  if (options.payoutInputs.length === 0) {
    const defaultMetricsPath = path.join(process.cwd(), "observability", "payouts");
    if (fs.existsSync(defaultMetricsPath)) {
      options.payoutInputs.push(defaultMetricsPath);
    }
  }

  return options;
};

type Primitive = string | number | boolean | null | undefined;

type LogRecord = Record<string, unknown> & {
  timestamp?: string;
  message?: string;
  level?: string;
};

const dateSchema = z
  .string()
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), {
    message: "Invalid ISO timestamp",
  });

const payoutRecordSchema = z
  .object({
    payoutId: z.string(),
    status: z.string(),
    reconResidual: z.number(),
    closedAt: z.string().optional(),
  })
  .strict();

const readJsonLines = (content: string): LogRecord[] => {
  const entries: LogRecord[] = [];
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed as LogRecord);
      }
    } catch (error) {
      console.warn(`Skipping unparsable log line: ${line.slice(0, 120)}`);
    }
  }

  return entries;
};

const collectLogFiles = (inputPath: string): string[] => {
  if (!fs.existsSync(inputPath)) {
    return [];
  }

  const stats = fs.statSync(inputPath);
  if (stats.isDirectory()) {
    const entries = fs.readdirSync(inputPath);
    return entries
      .flatMap((entry) => collectLogFiles(path.join(inputPath, entry)))
      .filter((file) => SUPPORTED_LOG_EXTENSIONS.has(path.extname(file)));
  }

  if (stats.isFile()) {
    const extension = path.extname(inputPath);
    return SUPPORTED_LOG_EXTENSIONS.has(extension) ? [inputPath] : [];
  }

  return [];
};

const loadLogRecords = (paths: string[]): LogRecord[] => {
  const records: LogRecord[] = [];

  for (const inputPath of paths) {
    const files = collectLogFiles(inputPath);
    for (const file of files) {
      const extension = path.extname(file);
      const content = fs.readFileSync(file, "utf-8");

      if (extension === ".json") {
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            records.push(
              ...parsed.filter((entry): entry is LogRecord =>
                Boolean(entry && typeof entry === "object"),
              ),
            );
          } else if (parsed && typeof parsed === "object") {
            const candidate = (parsed as { logs?: unknown }).logs;
            if (Array.isArray(candidate)) {
              records.push(
                ...candidate.filter((entry): entry is LogRecord =>
                  Boolean(entry && typeof entry === "object"),
                ),
              );
            }
          }
        } catch (error) {
          console.warn(`Failed to parse JSON log file ${file}:`, error);
        }
      } else {
        records.push(...readJsonLines(content));
      }
    }
  }

  return records;
};

const loadPayoutRecords = (paths: string[]): z.infer<typeof payoutRecordSchema>[] => {
  const payouts: z.infer<typeof payoutRecordSchema>[] = [];

  for (const inputPath of paths) {
    if (!fs.existsSync(inputPath)) {
      continue;
    }

    const stats = fs.statSync(inputPath);
    if (stats.isDirectory()) {
      const nested = fs
        .readdirSync(inputPath)
        .map((entry) => path.join(inputPath, entry));
      payouts.push(...loadPayoutRecords(nested));
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    const extension = path.extname(inputPath);
    if (!SUPPORTED_LOG_EXTENSIONS.has(extension) && extension !== ".csv") {
      continue;
    }

    const content = fs.readFileSync(inputPath, "utf-8");

    if (extension === ".csv") {
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const [header, ...rows] = lines;
      const columns = header.split(",").map((column) => column.trim());
      const payoutIdIndex = columns.findIndex((column) => /payout/i.test(column));
      const residualIndex = columns.findIndex((column) => /residual/i.test(column));
      const statusIndex = columns.findIndex((column) => /status/i.test(column));

      for (const row of rows) {
        const cells = row.split(",");
        if (payoutIdIndex === -1 || residualIndex === -1 || statusIndex === -1) {
          continue;
        }
        const payoutId = cells[payoutIdIndex]?.trim();
        const residual = Number(cells[residualIndex]);
        const status = cells[statusIndex]?.trim();
        if (!payoutId || !Number.isFinite(residual) || !status) {
          continue;
        }
        payouts.push(
          payoutRecordSchema.parse({
            payoutId,
            status,
            reconResidual: residual,
          }),
        );
      }
      continue;
    }

    const logRecords = extension === ".json" ? loadLogRecords([inputPath]) : readJsonLines(content);
    for (const record of logRecords) {
      try {
        const parsed = payoutRecordSchema.parse(record);
        payouts.push(parsed);
      } catch (error) {
        // skip incompatible records
      }
    }
  }

  return payouts;
};

const coercePrimitive = (value: unknown): Primitive => {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
};

const toBoolean = (value: Primitive): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
};

const getNestedValue = (record: LogRecord, pathSegments: string[]): unknown => {
  return pathSegments.reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    return (value as Record<string, unknown>)[segment];
  }, record);
};

const hasV2Flag = (record: LogRecord): boolean => {
  const candidateKeys = [
    ["USE_V2_PROCESSOR"],
    ["env", "USE_V2_PROCESSOR"],
    ["environment", "USE_V2_PROCESSOR"],
    ["metadata", "USE_V2_PROCESSOR"],
    ["meta", "USE_V2_PROCESSOR"],
    ["flags", "USE_V2_PROCESSOR"],
    ["context", "USE_V2_PROCESSOR"],
    ["data", "USE_V2_PROCESSOR"],
  ];

  for (const keyPath of candidateKeys) {
    const primitive = coercePrimitive(getNestedValue(record, keyPath));
    const booleanValue = toBoolean(primitive);
    if (typeof booleanValue === "boolean") {
      return booleanValue;
    }
  }

  if (Array.isArray((record as Record<string, unknown>).tags)) {
    const tags = (record as { tags: unknown }).tags as unknown[];
    const normalized = tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.toLowerCase());
    if (normalized.includes("use_v2_processor") || normalized.includes("use_v2_processor=true")) {
      return true;
    }
  }

  const message = (record.message ?? "").toLowerCase();
  if (message.includes("use_v2_processor=true")) {
    return true;
  }

  return false;
};

const extractTimestamp = (record: LogRecord): Date | undefined => {
  const candidateKeys = ["timestamp", "time", "@timestamp", "loggedAt"];
  for (const key of candidateKeys) {
    const value = record[key as keyof LogRecord];
    if (typeof value === "string") {
      const result = dateSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }
    }
  }
  return undefined;
};

const getMessage = (record: LogRecord): string => {
  const message = coercePrimitive(record.message) ?? coercePrimitive((record as Record<string, unknown>).msg);
  return typeof message === "string" ? message : "";
};

const extractDocNumber = (record: LogRecord): { docNumber: string; docType?: string } | undefined => {
  const candidateKeys = [
    ["qbo", "docNumber"],
    ["docNumber"],
    ["DocNumber"],
    ["fields", "docNumber"],
    ["payload", "DocNumber"],
  ];

  for (const keyPath of candidateKeys) {
    const primitive = coercePrimitive(getNestedValue(record, keyPath));
    if (typeof primitive === "string" && primitive.trim().length > 0) {
      const typePrimitive = coercePrimitive(
        getNestedValue(record, [keyPath[0] === "docNumber" ? "docType" : keyPath[0], "docType"].filter(Boolean) as string[]),
      );
      const docType = typeof typePrimitive === "string" ? typePrimitive : undefined;
      return { docNumber: primitive.trim(), docType };
    }
  }

  return undefined;
};

const detectLegacyFallback = (record: LogRecord): boolean => {
  const flags = [
    coercePrimitive(getNestedValue(record, ["fallbackToLegacy"])),
    coercePrimitive(getNestedValue(record, ["legacyFallback"])),
    coercePrimitive(getNestedValue(record, ["fields", "fallback"])),
  ];

  for (const flag of flags) {
    const booleanValue = toBoolean(flag);
    if (booleanValue === true) {
      return true;
    }
  }

  const message = getMessage(record).toLowerCase();
  return message.includes("fallback") && message.includes("legacy");
};

const detectSfExternalIdConflict = (record: LogRecord): boolean => {
  const message = getMessage(record).toLowerCase();
  if (message.includes("duplicate") && message.includes("external")) {
    return true;
  }
  if (message.includes("upsert") && message.includes("conflict")) {
    return true;
  }

  const errorCode = coercePrimitive(getNestedValue(record, ["sfErrorCode"])) ??
    coercePrimitive(getNestedValue(record, ["errorCode"])) ??
    coercePrimitive(getNestedValue(record, ["fields", "errorCode"]));
  if (typeof errorCode === "string" && errorCode.toUpperCase().includes("DUPLICATE")) {
    return true;
  }

  return false;
};

const formatStatus = (label: string, count: number, expectation: string): string => {
  const icon = count === 0 ? "✅" : "❌";
  return `${icon} ${label}: ${count} (${expectation})`;
};

const summarizeDocNumbers = (
  records: LogRecord[],
): { duplicates: Map<string, LogRecord[]>; total: number } => {
  const map = new Map<string, LogRecord[]>();
  let total = 0;

  for (const record of records) {
    const doc = extractDocNumber(record);
    if (!doc) {
      continue;
    }
    total += 1;
    const key = `${doc.docType ?? "unknown"}::${doc.docNumber}`;
    const existing = map.get(key) ?? [];
    existing.push(record);
    map.set(key, existing);
  }

  const duplicates = new Map<string, LogRecord[]>();
  for (const [key, entries] of map.entries()) {
    if (entries.length > 1) {
      duplicates.set(key, entries);
    }
  }

  return { duplicates, total };
};

const summarizePayoutResiduals = (payouts: z.infer<typeof payoutRecordSchema>[]) => {
  const closed = payouts.filter((payout) => payout.status.toLowerCase() === "closed");
  const nonZeroResiduals = closed.filter((payout) => Math.abs(payout.reconResidual) > 1e-6);
  return { closedCount: closed.length, nonZeroResiduals };
};

const main = () => {
  try {
    const { logInputs, payoutInputs, days } = parseArgs(process.argv.slice(2));

    const lookbackMs = days * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const allRecords = loadLogRecords(logInputs);
    const filtered = allRecords.filter((record) => {
      if (!hasV2Flag(record)) {
        return false;
      }
      const timestamp = extractTimestamp(record);
      if (!timestamp) {
        return false;
      }
      return now - timestamp.getTime() <= lookbackMs;
    });

    const fallbackCount = filtered.filter(detectLegacyFallback).length;
    const { duplicates, total: qboTotal } = summarizeDocNumbers(filtered);
    const sfConflicts = filtered.filter(detectSfExternalIdConflict);

    const payoutRecords = loadPayoutRecords(payoutInputs);
    const payoutSummary = summarizePayoutResiduals(payoutRecords);

    const allChecksGreen =
      fallbackCount === 0 &&
      duplicates.size === 0 &&
      sfConflicts.length === 0 &&
      payoutSummary.nonZeroResiduals.length === 0;

    console.log("V2 Processor Adoption Report");
    console.log(`Time window: last ${days} day(s)`);
    console.log(`Observed log entries with USE_V2_PROCESSOR=true: ${filtered.length}`);
    console.log(formatStatus("Legacy fallbacks", fallbackCount, "expected 0"));
    console.log(
      formatStatus(
        "Duplicate QBO DocNumbers",
        duplicates.size,
        qboTotal > 0 ? "expected 0 duplicates" : "no QBO postings observed",
      ),
    );
    console.log(formatStatus("Salesforce External-ID conflicts", sfConflicts.length, "expected 0"));

    if (payoutRecords.length > 0) {
      console.log(
        formatStatus(
          "Closed payout residuals",
          payoutSummary.nonZeroResiduals.length,
          `checked ${payoutSummary.closedCount} closed payout(s)`,
        ),
      );
    } else {
      console.log("⚠️ No payout metrics supplied; skipping residual verification");
    }

    if (duplicates.size > 0) {
      console.log("\nDuplicate DocNumbers detected:");
      for (const [key, entries] of duplicates.entries()) {
        console.log(`- ${key}: ${entries.length} entries`);
      }
    }

    if (sfConflicts.length > 0) {
      console.log("\nSalesforce External-ID conflicts detected:");
      for (const conflict of sfConflicts) {
        console.log(`- ${getMessage(conflict)}`);
      }
    }

    if (payoutSummary.nonZeroResiduals.length > 0) {
      console.log("\nClosed payouts with non-zero residuals:");
      for (const payout of payoutSummary.nonZeroResiduals) {
        console.log(`- ${payout.payoutId}: residual ${payout.reconResidual}`);
      }
    }

    process.exit(allChecksGreen ? 0 : 1);
  } catch (error) {
    console.error("Failed to generate V2 processor report:");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

main();
