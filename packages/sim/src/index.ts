/**
 * @jnpa/sim — schema-accurate simulators, seeded synthetic generators, and the
 * CloudEvents/event-bus contracts shared across UC1/UC2/UC3 (Addendum B.3).
 * Everything here is deterministic given a seed.
 */
export * from './rng.js';
export * from './clock.js';
export * from './events/index.js';
export * from './generators/index.js';
export * from './injectors.js';
export * from './sim-world.js';
export * from './registry.js';
