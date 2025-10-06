const noopFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "{}",
});

(globalThis as { fetch?: typeof fetch }).fetch = noopFetch as unknown as typeof fetch;

const runSequentially = async () => {
  console.log("Running normalize spec...");
  const { runNormalizeSpec } = await import(
    "./integration/normalize.stripe.spec"
  );
  await runNormalizeSpec();

  console.log("Running ledger spec...");
  const { runLedgerSpec } = await import("./unit/ledger.spec");
  await runLedgerSpec();

  console.log("Running route spec...");
  const { runProcessRouteSpec } = await import("./unit/process.route.spec");
  await runProcessRouteSpec();

  console.log("Running types spec...");
  const { runTypesSpec } = await import("./unit/types.keys.spec");
  runTypesSpec();

  console.log("Running process transaction integration spec...");
  const { runProcessTransactionIntegration } = await import(
    "./integration/process_transaction.integration.spec"
  );
  await runProcessTransactionIntegration();
  console.log("All custom specs completed");
};

runSequentially().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
