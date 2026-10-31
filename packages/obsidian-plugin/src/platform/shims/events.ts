/**
 * `events` — 데스크톱이면 Node 의 `EventEmitter`. 모바일이면 async-sema(요청 간격 게이트)가 쓰는 만큼만 —
 * `on` · `once` · `off` · `emit`.
 */
import type * as NodeEvents from "node:events";
import { nodeModule } from "../node.js";

type Listener = (...args: unknown[]) => void;

class MinimalEventEmitter {
  private readonly listeners = new Map<string | symbol, Listener[]>();

  on(event: string | symbol, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string | symbol, listener: Listener): this {
    const remaining = (this.listeners.get(event) ?? []).filter((l) => l !== listener);
    if (remaining.length > 0) this.listeners.set(event, remaining);
    else this.listeners.delete(event);
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const current = this.listeners.get(event);
    if (!current) return false;
    for (const listener of [...current]) listener(...args);
    return true;
  }

  listenerCount(event: string | symbol): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  setMaxListeners(): this {
    return this;
  }
}

const events = nodeModule<typeof NodeEvents>("events");

export const EventEmitter = (events?.EventEmitter ??
  MinimalEventEmitter) as unknown as typeof NodeEvents.EventEmitter;
export default EventEmitter;
