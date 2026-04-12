import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const APP_NAME = 'stack-compass';
export const APP_VERSION: string = pkg.version;
