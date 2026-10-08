import { createHandler } from './core.js';
import { withNeon } from './db.js';

export const handle = createHandler({ withDb: (fn) => withNeon(fn) });
