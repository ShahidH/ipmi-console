import type { OjvApi } from '../shared/api';

declare global {
  interface Window { ojv: OjvApi }
}

/** The preload bridge. Read lazily so tests can install a fake first. */
export const api = (): OjvApi => window.ojv;
