/** Indirection for `realpath` so unit tests can mock failures without spying on `node:fs/promises` in ESM. */
export { realpath } from "node:fs/promises";
