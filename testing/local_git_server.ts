export interface GitServer {
  url: string;
  requests: { gets: number; posts: number; bytes: number };
  close(): Promise<void>;
  reset(): void;
}

export function startGitServer(root: string): GitServer {
  const requests = { gets: 0, posts: 0, bytes: 0 };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET") requests.gets++;
      else requests.posts++;
      const body = new Uint8Array(await request.arrayBuffer());
      const env: Record<string, string> = {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: "",
        REMOTE_ADDR: "127.0.0.1",
      };
      const output = await new Deno.Command("git", {
        args: ["http-backend"],
        env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = output.stdin.getWriter();
      await writer.write(body);
      await writer.close();
      const result = await output.output();
      requests.bytes += result.stdout.length;
      const split = findHeaderEnd(result.stdout);
      const headerText = new TextDecoder().decode(result.stdout.subarray(0, split.headersEnd));
      const headers = new Headers();
      let status = 200;
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers.append(key, value);
      }
      return new Response(result.stdout.subarray(split.bodyStart), { status, headers });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}/repo.git`,
    requests,
    close: () => server.shutdown(),
    reset: () => {
      requests.gets = 0;
      requests.posts = 0;
      requests.bytes = 0;
    },
  };
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
