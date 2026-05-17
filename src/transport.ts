import { Result } from "better-result";
import { TransportError } from "./errors.ts";
import type { HttpTransportResponse } from "./types.ts";

const USER_AGENT = "git/2.0 (git-remote-ops-deno)";

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function readResponse(
  response: Response,
  method: string,
  url: string,
): Promise<Result<HttpTransportResponse, TransportError>> {
  if (!response.ok) {
    return Result.err(
      new TransportError({
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        message: `${method} failed: ${response.status} ${response.statusText}`,
      }),
    );
  }
  const body = await Result.tryPromise({
    try: () => response.arrayBuffer(),
    catch: (cause) =>
      new TransportError({
        method,
        url,
        message: `${method} failed reading response body`,
        cause,
      }),
  });
  if (body.isErr()) return Result.err(body.error);
  return Result.ok({
    body: new Uint8Array(body.value),
    status: response.status,
  });
}

export async function getSmartHttp(
  url: string,
  path: string,
): Promise<Result<HttpTransportResponse, TransportError>> {
  const requestUrl = `${trimUrl(url)}${path}`;
  const response = await Result.tryPromise({
    try: () => fetch(requestUrl, { headers: { "User-Agent": USER_AGENT } }),
    catch: (cause) =>
      new TransportError({
        method: "GET",
        url: requestUrl,
        message: `GET ${path} failed`,
        cause,
      }),
  });
  if (response.isErr()) return Result.err(response.error);
  return readResponse(response.value, `GET ${path}`, requestUrl);
}

export async function postUploadPack(
  url: string,
  body: Uint8Array,
): Promise<Result<HttpTransportResponse, TransportError>> {
  const requestUrl = `${trimUrl(url)}/git-upload-pack`;
  const response = await Result.tryPromise({
    try: () =>
      fetch(requestUrl, {
        method: "POST",
        body: body as BodyInit,
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Accept": "application/x-git-upload-pack-result",
          "User-Agent": USER_AGENT,
          "Connection": "close",
        },
      }),
    catch: (cause) =>
      new TransportError({
        method: "POST",
        url: requestUrl,
        message: "POST git-upload-pack failed",
        cause,
      }),
  });
  if (response.isErr()) return Result.err(response.error);
  return readResponse(response.value, "POST git-upload-pack", requestUrl);
}
