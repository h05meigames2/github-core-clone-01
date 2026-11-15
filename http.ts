// http.ts — the small request/response context every surface handler shares.

export interface ReqCtx {
  method: string;
  /** The URL path, percent-decoded per segment, no trailing slash (except "/"). */
  path: string;
  /** The path split on "/", each segment decoded. */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  /** The parsed JSON body, when the request carried one and it parsed. */
  body: unknown;
  /** True when a JSON body was present but did not parse. */
  bodyParseError: boolean;
  host: string;
}

export interface Resp {
  status: number;
  contentType: string;
  body: Buffer;
  extraHeaders?: Record<string, string>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function jsonResp(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Resp {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), extraHeaders };
}

export function errResp(status: number, message: string, extraHeaders: Record<string, string> = {}): Resp {
  return jsonResp(status, { message }, extraHeaders);
}

export function noContentResp(extraHeaders: Record<string, string> = {}): Resp {
  return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0), extraHeaders };
}

/** Decode one path segment, tolerating a bad escape. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a raw path into decoded segments. */
export function splitPath(rawPath: string): string[] {
  const clean = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  return clean.split('/').filter((part) => part !== '').map(decodeSegment);
}
