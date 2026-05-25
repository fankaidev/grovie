import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminApiRunLogResponse, AdminApiRunLogStreamEvent } from "../../admin-api.js";
import type { LocalRunSummary } from "../../status.js";
import { readRunLog } from "./run-data.js";

export function startRunLogStream(
  request: IncomingMessage,
  response: ServerResponse,
  run: LocalRunSummary,
  stream: "stdout" | "stderr",
): void {
  const initialLog = readRunLog(run, stream);
  let offset = Buffer.byteLength(initialLog.content, "utf8");

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const snapshot: AdminApiRunLogResponse = {
    runId: run.runId,
    stream,
    path: initialLog.path,
    content: initialLog.content,
  };
  writeServerSentEvent(response, "snapshot", snapshot);

  const interval = setInterval(() => {
    const nextLog = readRunLog(run, stream);
    const nextBuffer = Buffer.from(nextLog.content, "utf8");

    if (nextBuffer.length <= offset) {
      return;
    }

    const content = nextBuffer.subarray(offset).toString("utf8");
    offset = nextBuffer.length;
    const append: AdminApiRunLogResponse = {
      runId: run.runId,
      stream,
      path: nextLog.path,
      content,
    };
    writeServerSentEvent(response, "append", append);
  }, 100);

  request.on("close", () => {
    clearInterval(interval);
  });
}

function writeServerSentEvent(
  response: ServerResponse,
  event: AdminApiRunLogStreamEvent["event"],
  value: AdminApiRunLogStreamEvent["data"],
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}
