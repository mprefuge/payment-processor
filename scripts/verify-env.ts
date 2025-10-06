#!/usr/bin/env ts-node
import { EnvValidationError, getEnv } from "../src/config/env";

type ExitCode = 0 | 1;

const main = (): ExitCode => {
  try {
    getEnv();
    // eslint-disable-next-line no-console
    console.log("OK");
    return 0;
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // eslint-disable-next-line no-console
      console.error("Environment validation failed:");
      for (const issue of error.issues) {
        const path = issue.path.join(".") || "<root>";
        // eslint-disable-next-line no-console
        console.error(` - ${path}: ${issue.message}`);
      }
      return 1;
    }

    // eslint-disable-next-line no-console
    console.error("Unexpected error while validating environment:", error);
    return 1;
  }
};

process.exit(main());
