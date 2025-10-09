const handlerPath = require.resolve('../dist/handlers/healthCheck');
delete require.cache[handlerPath];
const handler = require('../dist/handlers/healthCheck');
module.exports = handler;
