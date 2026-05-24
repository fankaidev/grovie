import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const source = join(process.cwd(), "admin-web", "dist");
const target = join(process.cwd(), "dist", "admin-web");

if (!existsSync(source)) {
  throw new Error("admin-web build output is missing. Run `pnpm build:admin-web` first.");
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
