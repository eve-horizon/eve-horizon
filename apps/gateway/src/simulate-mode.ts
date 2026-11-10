/**
 * Simulate mode (`EVE_SIMULATE_ENABLED=true`) is for local development and
 * tests: it turns on `POST /gateway/providers/simulate` and lets an inbound
 * message carry its sender's email. Off unless set explicitly.
 */
export function isSimulateEnabled(): boolean {
  return (process.env.EVE_SIMULATE_ENABLED ?? '').toLowerCase() === 'true';
}
