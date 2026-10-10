const BASE = import.meta.env.VITE_API_BASE ?? "/api/v1";

/** The server answered with an error status. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: { path: (string | number)[]; message: string }[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request never produced a response (offline, timeout, dropped connection). The outcome is unknown. */
export class NetworkError extends Error {
  constructor() {
    super("Cannot reach the server. Check the connection and try again.");
    this.name = "NetworkError";
  }
}

let unauthorizedHandler: (() => void) | null = null;
export const onUnauthorized = (fn: (() => void) | null) => {
  unauthorizedHandler = fn;
};

interface Options {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the global session-expired handling (used by login itself). */
  skipAuthRedirect?: boolean;
  signal?: AbortSignal;
}

function describe(status: number, data: { error?: string; issues?: { path: (string | number)[]; message: string }[] } | null) {
  if (data?.issues?.length) {
    const i = data.issues[0];
    return `${i.path.join(".") || "Request"}: ${i.message}`;
  }
  return data?.error ?? `Request failed (${status})`;
}

export async function request<T>(path: string, opts: Options = {}): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      credentials: "include",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new NetworkError();
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !opts.skipAuthRedirect) unauthorizedHandler?.();
    throw new ApiError(res.status, describe(res.status, data), data?.issues);
  }
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

/** Fetches a file with the session cookie and saves it. Throws the same ApiError / NetworkError as normal calls. */
export async function download(path: string, query: Options["query"], fallbackName: string): Promise<string> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, describe(res.status, data), data?.issues);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  return name;
}