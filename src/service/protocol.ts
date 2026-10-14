/**
 * Public service protocol re-export.
 *
 * Keeping this entry point under `service/` makes it convenient for HTTP
 * adapters while the implementation lives in the dependency-free protocol
 * module and can also be imported from the package root.
 */
export * from '../protocol/index.js';
