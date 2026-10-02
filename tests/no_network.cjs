// Inherited by test child processes through NODE_OPTIONS. Unexpected network is a failure.
const block = () => { throw new Error('TEST_NETWORK_FORBIDDEN'); };
for (const n of ['node:http', 'node:https']) { const m = require(n); m.request = block; m.get = block; }
const net = require('node:net'); net.connect = block; net.createConnection = block;
const tls = require('node:tls'); tls.connect = block;
global.fetch = block;
