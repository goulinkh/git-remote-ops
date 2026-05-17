/**
 * @module transport
 *
 * Thin `fetch` wrappers for the two HTTP endpoints the smart-HTTP Git
 * protocol uses:
 *
 *  - `GET <repo>/info/refs?service=git-upload-pack` — capability/ref ad.
 *  - `POST <repo>/git-upload-pack` — the actual fetch request, body framed
 *    by the protocol layer.
 *
 * Both helpers turn errors into {@link TransportError} (never throw) and
 * record timing / byte counts onto the supplied {@link Logger}.
 */
import { Result } from "better-result";
import { writeFile } from "node:fs/promises";
import { TransportError } from "./errors.js";
import { Logger, NULL_LOGGER } from "./logger.js";
import type {
  GitProtocolOptions,
  HttpFileTransportResponse,
  HttpTransportResponse,
} from "./types.js";

/** Sent verbatim as `User-Agent`. Git servers sometimes log this. */
const USER_AGENT = "git/2.0 (git-remote-ops)";

/** Per-request transport context: protocol version + optional logger. */
export interface TransportContext extends GitProtocolOptions {
  logger?: Logger;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function protocolHeaders(options?: GitProtocolOptions): HeadersInit {
  return options?.protocolVersion === 2 ? { "Git-Protocol": "version=2" } : {};
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

/**
 * Issue a smart-HTTP GET to `${url}${path}`. Used to fetch the ref/capability
 * advertisement. When `protocolVersion === 2`, sends `Git-Protocol: version=2`
 * so the server responds with a v2 capability ad instead of the legacy format.
 */
export async function getSmartHttp(
  url: string,
  path: string,
  options?: TransportContext,
): Promise<Result<HttpTransportResponse, TransportError>> {
  const logger = options?.logger ?? NULL_LOGGER;
  const requestUrl = `${trimUrl(url)}${path}`;
  logger.debug(`GET ${path} (protocol=${options?.protocolVersion ?? 0})`);
  const start = performance.now();
  const response = await Result.tryPromise({
    try: () =>
      fetch(requestUrl, {
        headers: { "User-Agent": USER_AGENT, ...protocolHeaders(options) },
      }),
    catch: (cause) =>
      new TransportError({
        method: "GET",
        url: requestUrl,
        message: `GET ${path} failed`,
        cause,
      }),
  });
  if (response.isErr()) return Result.err(response.error);
  const read = await readResponse(response.value, `GET ${path}`, requestUrl);
  const durationMs = performance.now() - start;
  if (read.isOk()) {
    logger.recordHttp({ bytesIn: read.value.body.length, bytesOut: 0, durationMs });
    logger.debug(
      `GET ${path} -> ${response.value.status}, ${read.value.body.length}B in ${
        durationMs.toFixed(1)
      }ms`,
    );
  }
  return read;
}

/**
 * POST a `git-upload-pack` request body. Sets the magic content/accept types
 * the upload-pack service expects and forwards the response bytes as-is for
 * the protocol layer to demux.
 *
 * `Connection: close` is set explicitly because some servers (notably
 * `dumb-http-bridge` setups) hang on keep-alive.
 */
export async function postUploadPack(
  url: string,
  body: Uint8Array,
  destPath: string,
  options?: TransportContext,
): Promise<Result<HttpFileTransportResponse, TransportError>> {
  const logger = options?.logger ?? NULL_LOGGER;
  const requestUrl = `${trimUrl(url)}/git-upload-pack`;
  logger.debug(`POST git-upload-pack (${body.length}B, protocol=${options?.protocolVersion ?? 0})`);
  const start = performance.now();
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
          ...protocolHeaders(options),
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
  if (!response.value.ok) {
    return Result.err(
      new TransportError({
        method: "POST",
        url: requestUrl,
        status: response.value.status,
        statusText: response.value.statusText,
        message: `POST failed: ${response.value.status} ${response.value.statusText}`,
      }),
    );
  }
  if (!response.value.body) {
    return Result.err(
      new TransportError({
        method: "POST",
        url: requestUrl,
        message: "POST git-upload-pack response had no body",
      }),
    );
  }
  const streamed = await Result.tryPromise({
    try: async () => {
      const bytes = new Uint8Array(await response.value.arrayBuffer());
      await writeFile(destPath, bytes);
      return bytes.length;
    },
    catch: (cause) =>
      new TransportError({
        method: "POST",
        url: requestUrl,
        message: "POST git-upload-pack failed writing response body",
        cause,
      }),
  });
  const durationMs = performance.now() - start;
  if (streamed.isErr()) return Result.err(streamed.error);
  logger.recordHttp({
    bytesIn: streamed.value,
    bytesOut: body.length,
    durationMs,
  });
  logger.debug(
    `POST git-upload-pack -> ${response.value.status}, ${streamed.value}B in ${
      durationMs.toFixed(1)
    }ms`,
  );
  return Result.ok({ path: destPath, length: streamed.value, status: response.value.status });
}
