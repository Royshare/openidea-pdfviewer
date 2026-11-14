/**
 * Client of the plugin's code (`src/protocol.rs`): request/answer over the
 * frame bridge, with ids (a per-bridge random token plus a counter) so two
 * tabs of the viewer never mix their answers up.
 *
 * A request that is never answered (the plugin failed to activate, the
 * capability is missing) rejects after a timeout, so the page shows an error
 * instead of a spinner forever.
 */

import { fromBase64 } from "./base64";

export type Reply =
  | { op: "info"; id: string; path: string | null }
  | { op: "value"; id: string; key: string; value: string | null }
  | { op: "ok"; id: string; key: string }
  | { op: "keys"; id: string; prefix: string; keys: string[] }
  | { op: "pong"; id: string }
  | { op: "none"; id: string; reason: string }
  | { op: "bytes"; id: string; part: number; parts: number; data: string }
  | { op: "error"; id: string; message: string };

/** The parts of a `read` put back together (never sent as such). */
interface FileReply {
  op: "file";
  id: string;
  bytes: Uint8Array;
}

interface Waiter {
  resolve: (reply: Reply | FileReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long a call waits for the component before giving up. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 16 hex characters (64 random bits). The code rejects ids over 64 characters
 * (`MAX_ID` in `src/protocol.rs`); `<token>:<seq>` stays far below that.
 */
function newToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class CodeBridge {
  #waiters = new Map<string, Waiter>();
  /** The parts of a `read` that have arrived, by request id. */
  #parts = new Map<string, (Uint8Array | undefined)[]>();
  #seq = 0;
  /**
   * Unique to this bridge. Every frame of the view receives every reply, and
   * each frame counts from zero, so the counter alone would let two tabs with
   * requests in flight accept each other's answers. Fixed for the bridge's
   * life: it prefixes every request id, and so every part of a multipart reply.
   */
  readonly #token = newToken();

  constructor(
    private readonly post: (text: string) => void,
    subscribe: (fn: (text: string) => void) => void,
  ) {
    subscribe((text) => this.#receive(text));
  }

  #receive(text: string): void {
    let reply: Reply;
    try {
      reply = JSON.parse(text) as Reply;
    } catch {
      return; // not ours
    }
    if (!reply || typeof reply.id !== "string") {
      return;
    }
    const waiter = this.#waiters.get(reply.id);
    if (!waiter) {
      return; // another tab's answer
    }
    let answer: Reply | FileReply = reply;
    if (reply.op === "bytes") {
      // A file the code read in place arrives in parts (a message is capped):
      // hold them until the last one, then hand the whole file over at once.
      const parts = this.#parts.get(reply.id) ?? new Array(reply.parts).fill(undefined);
      parts[reply.part] = fromBase64(reply.data);
      if (parts.some((part) => part === undefined)) {
        this.#parts.set(reply.id, parts);
        return;
      }
      this.#parts.delete(reply.id);
      const whole = parts as Uint8Array[];
      const bytes = new Uint8Array(whole.reduce((n, part) => n + part.length, 0));
      let at = 0;
      for (const part of whole) {
        bytes.set(part, at);
        at += part.length;
      }
      answer = { op: "file", id: reply.id, bytes };
    }
    this.#waiters.delete(reply.id);
    clearTimeout(waiter.timer);
    if (answer.op === "error") {
      waiter.reject(new Error(answer.message));
    } else {
      waiter.resolve(answer);
    }
  }

  #call(payload: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Reply | FileReply> {
    const id = `${this.#token}:${++this.#seq}`;
    return new Promise<Reply | FileReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        reject(new Error("The plugin's code did not answer."));
      }, timeoutMs);
      this.#waiters.set(id, { resolve, reject, timer });
      this.post(JSON.stringify({ id, ...payload }));
    });
  }

  /**
   * The tab's absolute path (API 1.3 `invocation.editor().path()`), or `null`
   * when the view has no file behind it. Best effort: a code that does not
   * answer costs the cache its identity, not the document its tab.
   */
  async info(): Promise<string | null> {
    try {
      const reply = await this.#call({ op: "info" }, 4_000);
      return reply.op === "info" ? reply.path : null;
    } catch {
      return null;
    }
  }

  /**
   * Fallback: the current tab's own file via API 1.5 project.read-bytes,
   * confined to the open project and capped at 16 MiB. The page never names a
   * path; `null` means there was no project/read grant or the read failed.
   */
  async read(): Promise<{ bytes: Uint8Array } | { reason: string } | null> {
    try {
      const reply = await this.#call({ op: "read" }, 30_000);
      if (reply.op === "file") {
        return { bytes: reply.bytes };
      }
      return reply.op === "none" ? { reason: reply.reason } : null;
    } catch {
      return null;
    }
  }

  /** The stored value, or `null`. Rejects when the code cannot answer. */
  async get(key: string): Promise<string | null> {
    const reply = await this.#call({ op: "get", key });
    return reply.op === "value" ? reply.value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.#call({ op: "set", key, value });
  }

  async delete(key: string): Promise<void> {
    await this.#call({ op: "del", key });
  }

  async keys(prefix: string): Promise<string[]> {
    const reply = await this.#call({ op: "keys", prefix });
    return reply.op === "keys" ? reply.keys : [];
  }

  /** Whether the component is there at all (used by the status bar). */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.#call({ op: "ping" }, 4_000);
      return reply.op === "pong";
    } catch {
      return false;
    }
  }
}
