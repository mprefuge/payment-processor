export type CounterName =
  | "events_ingested"
  | "post_success"
  | "post_failure"
  | "ledger_stuck";

type CounterStore = Record<CounterName, number>;

const counters: CounterStore = {
  events_ingested: 0,
  post_success: 0,
  post_failure: 0,
  ledger_stuck: 0,
};

export const incrementCounter = (name: CounterName, value = 1): void => {
  counters[name] += value;
};

export const getCounterSnapshot = (): CounterStore => ({
  events_ingested: counters.events_ingested,
  post_success: counters.post_success,
  post_failure: counters.post_failure,
  ledger_stuck: counters.ledger_stuck,
});

export const resetCountersForTest = (): void => {
  counters.events_ingested = 0;
  counters.post_success = 0;
  counters.post_failure = 0;
  counters.ledger_stuck = 0;
};
