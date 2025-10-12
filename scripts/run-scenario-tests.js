#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const scenarios = {
  'new-customer': {
    description: 'Validates CRM sync for first-time donors',
    tests: ['tests/checkoutCrmSync.test.js'],
  },
  'new-payment': {
    description: 'Covers initial payment capture and transaction creation',
    tests: ['tests/transactionCreationFlow.test.js'],
  },
  'new-recurring-payment': {
    description: 'Exercises recurring subscription payments syncing to Salesforce and QuickBooks',
    tests: ['tests/recurringSubscriptionSync.test.js'],
  },
  cancel: {
    description: 'Ensures canceled intents propagate to Salesforce',
    tests: ['tests/failedCanceledTransactions.test.js'],
  },
  refund: {
    description: 'Checks refund handling across accounting integrations',
    tests: ['tests/stripeQboSync.test.js'],
  },
  dispute: {
    description: 'Verifies dispute events fan out to CRM and accounting summaries',
    tests: ['tests/payoutCrmIntegration.test.js'],
  },
};

function printUsage() {
  console.error('Usage: node run-scenario-tests.js <scenario> [additional-scenarios...]');
  console.error('       node run-scenario-tests.js all');
  console.error('\nAvailable scenarios:');
  for (const [name, details] of Object.entries(scenarios)) {
    console.error(`  - ${name}: ${details.description}`);
  }
}

const requestedScenarios = process.argv.slice(2);
if (requestedScenarios.length === 0) {
  printUsage();
  process.exit(1);
}

let scenarioNames;
if (requestedScenarios.length === 1 && requestedScenarios[0] === 'all') {
  scenarioNames = Object.keys(scenarios);
} else {
  scenarioNames = [];
  for (const scenarioName of requestedScenarios) {
    const scenario = scenarios[scenarioName];
    if (!scenario) {
      console.error(`Unknown scenario: ${scenarioName}`);
      printUsage();
      process.exit(1);
    }
    if (!scenarioNames.includes(scenarioName)) {
      scenarioNames.push(scenarioName);
    }
  }
}

for (const scenarioName of scenarioNames) {
  const scenario = scenarios[scenarioName];

  console.log(`\n🚀 Running scenario: ${scenarioName}`);
  console.log(`ℹ️  ${scenario.description}`);
  console.log('');

  for (const relativeTestPath of scenario.tests) {
    const resolvedPath = path.resolve(__dirname, '..', relativeTestPath);
    console.log(`▶️  Executing ${path.relative(process.cwd(), resolvedPath)}`);
    const result = spawnSync(process.execPath, [resolvedPath], {
      stdio: 'inherit',
      env: process.env,
    });

    if (result.error) {
      console.error(`Failed to launch ${relativeTestPath}:`, result.error.message);
      process.exit(1);
    }

    if (typeof result.status === 'number' && result.status !== 0) {
      console.error(`Test runner exited with status ${result.status}`);
      process.exit(result.status);
    }
  }

  console.log(`\n✅ Scenario ${scenarioName} completed successfully.`);
}
