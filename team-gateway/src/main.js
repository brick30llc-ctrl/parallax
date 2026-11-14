import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";

const config = loadConfig();

if (!config.token && !config.noAuth) {
  console.error("GATEWAY_TOKEN is not set. Set it (and the same value as TREG_TOKEN for Parallax), or set GATEWAY_INSECURE_NO_AUTH=1 for a loopback-only test.");
  process.exit(1);
}

const gateway = createGateway(config);
const addr = await gateway.listen();
const on = (ok) => (ok ? "on" : "off");
console.log(
  `team gateway listening on port ${addr.port} (bind ${config.host === "127.0.0.1" ? "loopback" : "custom"}). ` +
    `image ${on(config.image.routerUrl)}, music ${on(config.music.url)}, speech ${on(config.speech.url)}, video off.`,
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await gateway.close();
    process.exit(0);
  });
}
