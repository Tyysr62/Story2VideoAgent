export type MediaKind = 'image' | 'video';
export interface Concurrency { image: number; video: number; }
const limit = (value: number, name: string) => {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error(`${name} 必须是 1–8 的整数`);
  return value;
};
export function resolveConcurrency(env: Record<string, string | undefined>): Concurrency {
  const parse = (name: string) => env[name] === undefined ? 3 : limit(Number(env[name]), name);
  return { image: parse('IMAGE_CONCURRENCY'), video: parse('VIDEO_CONCURRENCY') };
}

class Pool {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private size: number) {}
  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        this.active++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => { this.active--; this.drain(); });
      });
      this.drain();
    });
  }
  private drain() { while (this.active < this.size && this.waiting.length) this.waiting.shift()!(); }
}

/** Shared per application, so separate projects cannot multiply provider concurrency. */
export class MediaQueue {
  readonly limits: Readonly<Concurrency>;
  private pools: Record<MediaKind, Pool>;
  constructor(limits: Concurrency = { image: 3, video: 3 }) {
    this.limits = Object.freeze({ image: limit(limits.image, 'IMAGE_CONCURRENCY'), video: limit(limits.video, 'VIDEO_CONCURRENCY') });
    this.pools = { image: new Pool(limits.image), video: new Pool(limits.video) };
  }
  run<T>(kind: MediaKind, work: () => Promise<T>) { return this.pools[kind].run(work); }
  async batch<T>(kind: MediaKind, items: readonly T[], work: (item: T, index: number, stop: () => void) => Promise<void | boolean>): Promise<boolean> {
    let stopped = false; let failure: { error: unknown } | undefined;
    await Promise.all(items.map((item, index) => this.run(kind, async () => {
      if (stopped) return;
      try { if (await work(item, index, () => { stopped = true; }) === false) stopped = true; }
      catch (error) { stopped = true; failure ??= { error }; }
    })));
    if (failure) throw failure.error;
    return !stopped;
  }
}
