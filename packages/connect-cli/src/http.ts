// packages/connect-cli/src/http.ts
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

interface HttpResult {
  status: number;
  data: unknown;
}

function doRequest(
  method: string,
  url: string,
  options: { body?: Record<string, unknown>; headers?: Record<string, string> },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const payload = options.body ? JSON.stringify(options.body) : undefined;

    const reqHeaders: Record<string, string> = { ...options.headers };
    if (payload) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = String(Buffer.byteLength(payload));
    }

    const req = reqFn(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function post(url: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<HttpResult> {
  return doRequest("POST", url, { body, headers });
}

export function get(url: string, headers?: Record<string, string>): Promise<HttpResult> {
  return doRequest("GET", url, { headers });
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}
