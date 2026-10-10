const DEFAULT_MAX_PENDING = 32;

type Work<T> = () => T | Promise<T>;

interface PendingWork {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  fallback: unknown;
}

interface Lane {
  running: boolean;
  pending: PendingWork[];
}

interface ThreadKeyParts {
  workspaceId?: string | null;
  channel: string;
  threadTs: string;
  programId?: string | null;
}

function threadKey({ workspaceId = null, channel, threadTs, programId = null }: ThreadKeyParts): string {
  return [workspaceId || "", channel || "", threadTs || "", programId || ""].join("\u0000");
}

class ThreadQueue {
  private readonly maxPending: number;

  private readonly lanes = new Map<string, Lane>();

  constructor({ maxPending = DEFAULT_MAX_PENDING }: { maxPending?: number } = {}) {
    if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error("maxPending must be a positive integer");
    this.maxPending = maxPending;
  }

  enqueue<T>(key: string, work: Work<T>, fallback: T): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: false, pending: [] };
      this.lanes.set(key, lane);
    }

    const promise = new Promise<T>((resolve, reject) => {
      if (lane!.pending.length >= this.maxPending) {
        const dropped = lane!.pending.shift();
        dropped?.resolve(dropped.fallback);
      }
      lane!.pending.push({
        run: () => Promise.resolve().then(work),
        resolve: resolve as (value: unknown) => void,
        reject,
        fallback,
      });
    });
    this.drain(key, lane);
    return promise;
  }

  private drain(key: string, lane: Lane): void {
    if (lane.running) return;
    const next = lane.pending.shift();
    if (!next) {
      this.lanes.delete(key);
      return;
    }

    lane.running = true;
    next
      .run()
      .then(next.resolve, next.reject)
      .finally(() => {
        lane.running = false;
        this.drain(key, lane);
      });
  }
}

export = { ThreadQueue, threadKey, DEFAULT_MAX_PENDING };
