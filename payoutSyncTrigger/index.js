const handlerPath = require.resolve('../dist/handlers/payoutSyncTrigger');
delete require.cache[handlerPath];
const handler = require('../dist/handlers/payoutSyncTrigger');
module.exports = handler;
