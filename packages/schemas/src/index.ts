/**
 * @jnpa/schemas — the contract for JNPA UC2.
 * Canonical entity types (§3), JSON-Schema validators, and EDI/X12/ICES/ULIP
 * mappers (§4). Every service and the UI bind to these types; nothing invents
 * its own field names.
 */
export * from './entities/index.js';
export * from './json-schema/index.js';
export * from './mappers/index.js';
export * from './cross-twin/contract.js';
