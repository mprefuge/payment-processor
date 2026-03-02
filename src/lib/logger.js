// This file exists to satisfy CommonJS modules that require the logger from JS
// code (e.g. qbo/stripe utilities).  It simply re-exports the TypeScript
// implementation so that tests running under ts-node/vitest can resolve it.

module.exports = require('./logger');
