const handlerPath = require.resolve('../dist/handlers/stripeTrueUp');
delete require.cache[handlerPath];
const handler = require('../dist/handlers/stripeTrueUp');
module.exports = handler;
