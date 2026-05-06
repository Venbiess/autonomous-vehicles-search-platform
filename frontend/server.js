const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || readArg("--port") || "3000", 10);
const hostname = process.env.HOSTNAME || readArg("--hostname") || "0.0.0.0";
const useWebpack = process.argv.includes("--webpack");
const useTurbopack = !useWebpack && process.argv.includes("--turbopack");

const nextOptions = {
  dev,
  hostname,
  port,
};

if (useWebpack) {
  nextOptions.webpack = true;
} else if (useTurbopack) {
  nextOptions.turbopack = true;
}

const app = next(nextOptions);
const handle = app.getRequestHandler();

const rawRequestTimeout = Number(process.env.FRONTEND_REQUEST_TIMEOUT_MS || "0");
const requestTimeoutMs =
  Number.isFinite(rawRequestTimeout) && rawRequestTimeout >= 0 ? rawRequestTimeout : 0;

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url || "/", true);
      await handle(req, res, parsedUrl);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error handling request", req.url, error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end("internal server error");
    }
  });

  // Needed for long-running snapshot upload streams.
  server.requestTimeout = requestTimeoutMs;

  server.listen(port, hostname, () => {
    // eslint-disable-next-line no-console
    console.log(
      `> Ready on http://${hostname}:${port} (mode=${dev ? "development" : "production"}, requestTimeout=${requestTimeoutMs}ms)`
    );
  });
});
