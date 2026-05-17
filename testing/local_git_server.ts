import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface GitServer {
  url: string;
  requests: { gets: number; posts: number; bytes: number };
  close(): Promise<void>;
  reset(): void;
}

export function startGitServer(root: string): GitServer {
  const requests = { gets: 0, posts: 0, bytes: 0 };
  const server = createServer((request, response) => {
    void handleGitRequest(root, requests, request, response);
  });
  server.listen(0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind git server");
  return {
    url: `http://127.0.0.1:${address.port}/repo.git`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    reset: () => {
      requests.gets = 0;
      requests.posts = 0;
      requests.bytes = 0;
    },
  };
}

async function handleGitRequest(
  root: string,
  requests: { gets: number; posts: number; bytes: number },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET") requests.gets++;
    else requests.posts++;
    const body = await readRequestBody(request);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method ?? "GET",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: "",
      REMOTE_ADDR: "127.0.0.1",
    };
    const result = await runGitHttpBackend(env, body);
    requests.bytes += result.length;
    const split = findHeaderEnd(result);
    const headerText = new TextDecoder().decode(result.subarray(0, split.headersEnd));
    let status = 200;
    for (const line of headerText.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else response.setHeader(key, value);
    }
    response.writeHead(status);
    response.end(result.subarray(split.bodyStart));
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.message : String(error));
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function runGitHttpBackend(env: NodeJS.ProcessEnv, body: Uint8Array): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(stdout)));
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
    child.stdin.end(body);
  });
}

function findHeaderEnd(bytes: Uint8Array): { headersEnd: number; bodyStart: number } {
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return { headersEnd: i, bodyStart: i + 4 };
    }
  }
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { headersEnd: i, bodyStart: i + 2 };
  }
  return { headersEnd: 0, bodyStart: 0 };
}
