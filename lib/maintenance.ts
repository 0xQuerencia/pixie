import http = require("node:http");
import log = require("./log");

function enabled(): boolean {
  return process.env.PIXIE_MAINTENANCE === "1";
}

function run(): http.Server {
  const port = Number(process.env.PORT) || Number(process.env.PIXIE_WEB_PORT) || 4100;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, maintenance: true }));
  });
  server.listen(port, "0.0.0.0");
  log.warn("maintenance", `maintenance mode: Slack, the database and every background job are off (port ${port})`);
  return server;
}

export = { enabled, run };
