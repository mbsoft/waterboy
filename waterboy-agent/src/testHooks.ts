/**
 * Dev/test-only hooks for QA. Inert unless WATERBOY_TEST_HOOKS=1, which the launchd job never
 * sets, so release builds behave normally. See the v0.4 test plan.
 */
export const testHooksOn = process.env.WATERBOY_TEST_HOOKS === "1";

const started = Date.now();

/** H1: the time, starting from WATERBOY_NOW (ISO date or epoch ms) while hooks are on, then advancing normally */
export function now(): number {
  const fake = testHooksOn ? process.env.WATERBOY_NOW : undefined;
  const start = fake ? (/^\d+$/.test(fake) ? Number(fake) : Date.parse(fake)) : NaN;
  return Number.isFinite(start) ? start + (Date.now() - started) : Date.now();
}
