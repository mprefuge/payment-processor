import { strict as assert } from "node:assert";
import {
  __testing,
  finalizeLedger,
  saveLedgerAttempt,
  save_event_if_new,
} from "../../src/services/persistence/repository";

export const runLedgerSpec = async () => {
  __testing.reset();

  const firstSave = await save_event_if_new("evt_123");
  assert.equal(firstSave.created, true, "first event should be created");
  const secondSave = await save_event_if_new("evt_123");
  assert.equal(secondSave.created, false, "duplicate event should not insert");
  assert.equal(__testing.getEvents().size, 1, "only one event stored");

  __testing.reset();

  const attempt = await saveLedgerAttempt("payment", "ch_123");
  const initialUpdatedAt = attempt.updated_at;
  assert.equal(attempt.status, "pending");
  assert.equal(attempt.entity_type, "payment");
  assert.equal(__testing.getLedger().size, 1);

  const duplicateAttempt = await saveLedgerAttempt("payment", "ch_123");
  assert.equal(__testing.getLedger().size, 1, "duplicate attempts should noop");
  assert.strictEqual(
    duplicateAttempt,
    attempt,
    "same record instance returned for duplicates",
  );

  const posted = await finalizeLedger("payment", "ch_123", "posted");
  assert.equal(posted.status, "posted");
  assert.equal(posted.error, undefined);
  assert.ok(posted.updated_at >= initialUpdatedAt);

  const postedUpdatedAt = posted.updated_at;
  const errored = await finalizeLedger("payment", "ch_123", "error", "boom");
  assert.equal(errored.status, "error");
  assert.equal(errored.error, "boom");
  assert.ok(errored.updated_at >= postedUpdatedAt);
};
