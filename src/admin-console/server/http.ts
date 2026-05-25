import type { ServerResponse } from "node:http";

export function writeJson<T>(response: ServerResponse, statusCode: number, value: T): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export function writeHtml(response: ServerResponse, statusCode: number, value: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(value);
}

export function parseRequestUrl(url: string | undefined): URL {
  return new URL(url ?? "/", "http://127.0.0.1");
}
