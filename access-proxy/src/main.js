import { ConfigError, loadConfig } from "./config.js";
import { createProxy } from "./server.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`access-proxy: ${err.message} Refusing to start.`);
  process.exit(1);
}

const proxy = createProxy(config);
const addr = await proxy.listen();
console.log(
  `access proxy listening on port ${addr.port}; verifying tokens for one Access application` +
    (config.allowedEmails.length ? `, ${config.allowedEmails.length} allowed email(s)` : "") +
    `; keys loaded: ${proxy.jwks.keys.size}.`,
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await proxy.close();
    process.exit(0);
  });
}
