/** Small LRU with an explicit pixel-memory budget, rather than a growing per-deal cache. */
export class BoundedCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(private readonly budget: number) {}
  get(key: string): T | undefined {
    const item = this.entries.get(key);
    if (!item) return undefined;
    this.entries.delete(key);
    this.entries.set(key, item);
    return item.value;
  }
  set(key: string, value: T, bytes: number): void {
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    if (bytes > this.budget) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.budget) {
      const key = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(key)!.bytes;
      this.entries.delete(key);
    }
  }
  get size(): number { return this.entries.size; }
  get byteSize(): number { return this.bytes; }
}
