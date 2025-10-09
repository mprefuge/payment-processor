const handlerPath = require.resolve('../dist/handlers/stripeWebhook');
delete require.cache[handlerPath];
const handler = require('../dist/handlers/stripeWebhook');
module.exports = handler;
