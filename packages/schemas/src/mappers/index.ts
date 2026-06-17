/**
 * Mapper registry (prompt §4). Every native format → canonical CargoEvent /
 * entity, with raw payload preserved by rawRef. Golden-file tests cover each.
 */

// EDIFACT
export * from './edifact/tokenizer.js';
export * from './edifact/codeco.js';
export * from './edifact/other-edifact.js';

// ANSI X12
export * from './x12/tokenizer.js';
export * from './x12/transactions.js';

// ICEGATE / ICES 1.5
export * from './ices/chsai.js';

// ULIP REST JSON
export * from './ulip/ulip-json.js';

// e-seal RFID
export * from './eseal/rfid.js';

// shared
export * from './support.js';
