import { z } from "zod";
const Message = z.object({ id: z.number().int().optional(), sessionId: z.string().optional(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional(), method: z.string().optional(), params: z.unknown().optional() });
export interface BrowserEvent {
  method: string;
  sessionId?: string;
  params: unknown;
}
/** Minimal bounded CDP transport; browser responses and events remain runtime-validated. */
export class BrowserProtocol {
  private next = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private failure: Error | null = null;
  private constructor(private readonly socket: WebSocket, readonly signal: AbortSignal) {
    socket.addEventListener("message", event => {
      if (this.failure || this.signal.aborted)
        return;
      try {
        if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 12 * 1024 * 1024)
          throw new Error("browser protocol response exceeded its limit");
        const message = Message.parse(JSON.parse(event.data));
        if (message.id !== undefined) {
          const waiting = this.pending.get(message.id);
          if (!waiting)
            return;
          this.pending.delete(message.id);
          if (message.error)
            waiting.reject(new Error(`browser protocol refused ${message.error.code}: ${message.error.message.slice(0, 500)}`));
          else
            waiting.resolve(message.result);
        }
        else if (message.method) {
          for (const listener of this.listeners)
            listener({ method: message.method, sessionId: message.sessionId, params: message.params });
        }
      }
      catch (error) {
        this.fail(error instanceof Error ? error : new Error("invalid browser protocol input"));
      }
    });
    socket.addEventListener("close", () => this.fail(new Error("browser protocol connection closed")));
    socket.addEventListener("error", () => this.fail(new Error("browser protocol connection failed")));
    signal.addEventListener("abort", () => this.fail(new Error("browser check stopped")), { once: true });
  }
  static async connect(url: string, signal: AbortSignal): Promise<BrowserProtocol> {
    if (signal.aborted)
      throw new Error("browser check stopped");
    const socket = new WebSocket(url);
    const client = new BrowserProtocol(socket, signal);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        socket.close();
        reject(new Error("browser check stopped"));
      };
      const open = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", open, { once: true });
      socket.addEventListener("error", () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("browser connection failed"));
      }, { once: true });
    });
    return client;
  }
  onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.failure)
      throw this.failure;
    if (this.signal.aborted)
      throw new Error("browser check stopped");
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiting of this.pending.values())
      waiting.reject(error);
    this.pending.clear();
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.close();
  }
  close(): void {
    this.fail(new Error("browser check closed"));
  }
}
