/**
 * @jnpa/data reference-data ingestion — pure, dependency-free transforms that map
 * the JNPA reference data package's machine-readable subset (shipping-line
 * IAL/EAL CSV + pre-parsed EIR JSON) into the canonical cargo model, for the
 * reference cargo source. This is a data-source concern, so it lives in @jnpa/data
 * (alongside the adapters), NOT in @jnpa/sim (which is synthetic simulation only).
 * The Node ingest script (scripts/ingest-reference) reads the files and drives
 * these transforms; nothing here touches the filesystem, so the whole path is
 * browser-safe and unit-testable, and a live feed can replace the file source
 * behind the same contracts.
 */
export * from './parse-shipline-csv.js';
export * from './parse-eir-json.js';
export * from './build-reference-dataset.js';
