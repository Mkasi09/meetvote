import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { Readable } from "node:stream";

const port = Number(process.env.PORT || 3000);
const apiUrl = new URL(process.env.API_INTERNAL_URL || "http://meetvote-api:8090");
const plugnmeetClientUrl = new URL(process.env.PLUGNMEET_CLIENT_URL || "http://localhost:8080");
const root = process.cwd();
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/logo.png": ["../elawini_estate_meetvote_logo.png", "image/png"],
  "/logo-white.png": ["logo-white.png", "image/png"],
  "/candidate-default.svg": ["candidate-default.svg", "image/svg+xml"]
};
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

async function proxyApi(request, response, pathname, search) {
  const targetUrl = new URL(apiUrl);
  targetUrl.pathname = pathname.slice(4);
  targetUrl.search = search;
  const headers = {};
  for (const name of ["accept", "authorization", "content-type"]) {
    if (request.headers[name]) headers[name] = request.headers[name];
  }
  const options = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    options.body = request;
    options.duplex = "half";
  }
  try {
    const result = await fetch(targetUrl, options);
    response.writeHead(result.status, {
      "content-type": result.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    if (!result.body || request.method === "HEAD") {
      response.end();
      return;
    }
    Readable.fromWeb(result.body).pipe(response);
  } catch {
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "MeetVote could not reach its service. Check your connection and try again." }));
  }
}

createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://localhost");
  const pathname = requestUrl.pathname;
  const isApiRequest = pathname.startsWith("/api/");
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": `camera=(self "${plugnmeetClientUrl.origin}"), microphone=(self "${plugnmeetClientUrl.origin}"), display-capture=(self "${plugnmeetClientUrl.origin}")`,
    "feature-policy": `camera 'self' ${plugnmeetClientUrl.origin}; microphone 'self' ${plugnmeetClientUrl.origin}; display-capture 'self' ${plugnmeetClientUrl.origin}`,
    "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${plugnmeetClientUrl.origin}; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
  };
  if (!["GET", "HEAD"].includes(request.method) &&
      !(isApiRequest && ["POST", "PUT", "DELETE", "OPTIONS"].includes(request.method))) {
    response.writeHead(405, { ...headers, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed.");
    return;
  }

  if (isApiRequest) {
    void proxyApi(request, response, pathname, requestUrl.search);
    return;
  }
  if (pathname === "/config.js") {
    const body = Buffer.from(`window.MEETVOTE_CONFIG = ${JSON.stringify({ apiUrl: "/api" })};`);
    response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8", "content-length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }

  const asset = files[pathname];
  if (!asset) {
    response.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }

  const path = asset[0] === "../elawini_estate_meetvote_logo.png" && existsSync(join(root, "logo.png"))
    ? join(root, "logo.png")
    : join(root, asset[0]);
  response.writeHead(200, { ...headers, "content-type": types[extname(path)] || asset[1] });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500, { ...headers, "content-type": "text/plain; charset=utf-8" });
    response.end("Unable to read application asset.");
  });
  stream.pipe(response);
}).listen(port, "0.0.0.0", () => console.log(`Elawini Estate MeetVote web app listening on ${port}`));
