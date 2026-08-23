// 'server-only' throws outside a React Server Component. Tests run plain Node,
// so the import is turned into a no-op here.
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'server-only') return {};
  return load.call(this, request, ...rest);
};
