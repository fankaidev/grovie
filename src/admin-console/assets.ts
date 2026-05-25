import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdminApiErrorResponse } from "../admin-api.js";
import type { AdminConsoleContext } from "./server.js";

function writeFile(response: ServerResponse, statusCode: number, path: string): void {
  response.writeHead(statusCode, {
    "content-type": contentTypeForPath(path),
  });
  response.end(readFileSync(path));
}

export function serveAdminWebAsset(context: AdminConsoleContext, url: URL, response: ServerResponse): boolean {
  const assetsDir = context.adminWebAssetsDir ?? resolveAdminWebAssetsDir();

  if (!existsSync(join(assetsDir, "index.html"))) {
    return false;
  }

  const requestedPath = decodeURIComponent(url.pathname);
  const filePath = requestedPath === "/"
    ? join(assetsDir, "index.html")
    : resolveAssetPath(assetsDir, requestedPath);

  if (filePath !== undefined && isRegularFile(filePath)) {
    writeFile(response, 200, filePath);
    return true;
  }

  if (hasFileExtension(requestedPath)) {
    writeJson(response, 404, {
      error: "not_found",
      message: "Admin console asset not found.",
    } satisfies AdminApiErrorResponse);
    return true;
  }

  writeFile(response, 200, join(assetsDir, "index.html"));
  return true;
}

function writeJson<T>(response: ServerResponse, statusCode: number, value: T): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function resolveAdminWebAssetsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const builtRelativeToModule = join(moduleDir, "admin-web");

  if (existsSync(join(builtRelativeToModule, "index.html"))) {
    return builtRelativeToModule;
  }

  return join(process.cwd(), "dist", "admin-web");
}

function resolveAssetPath(root: string, pathname: string): string | undefined {
  const normalized = normalize(pathname).replace(/^[/\\]+/, "");
  const path = join(root, normalized);
  const rootRelative = relative(root, path);

  if (rootRelative.startsWith("..") || rootRelative === "" || rootRelative.split(sep).includes("..")) {
    return undefined;
  }

  return path;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasFileExtension(pathname: string): boolean {
  return extname(pathname) !== "";
}

function contentTypeForPath(path: string): string {
  const extension = extname(path);

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".ico") {
    return "image/x-icon";
  }

  return "application/octet-stream";
}
