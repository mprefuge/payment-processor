// CommonJS bridge for legacy JS modules that require '../lib/logger'.
// Keep this file dependency-free so it works in plain Node CJS contexts.

const logger = {
	log: (...args) => console.log(...args),
	info: (...args) => console.info(...args),
	warn: (...args) => console.warn(...args),
	error: (...args) => console.error(...args),
	debug: (...args) => console.debug(...args),
};

module.exports = {
	logger,
	default: logger,
};
