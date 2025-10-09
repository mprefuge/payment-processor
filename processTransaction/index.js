const handlerPath = require.resolve('../dist/handlers/processTransaction');
delete require.cache[handlerPath];
const handler = require('../dist/handlers/processTransaction');
module.exports = handler;
