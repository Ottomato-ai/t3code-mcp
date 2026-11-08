import { loadParkedThreads } from "../config.js";
import type { DeliveryContext } from "../tools/queue.js";
import { DeliveryJournal } from "./journal.js";

let shared: DeliveryContext | undefined;

/** One journal and parked-thread list per process, read from the environment on first use. */
export function defaultDelivery(): DeliveryContext {
  return (shared ??= { journal: DeliveryJournal.fromEnv(), parked: loadParkedThreads() });
}
