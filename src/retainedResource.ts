/** Own one expensive renderer across mode changes. Invalidated asynchronous
 * construction is released on arrival, never attached to a newer canvas. */
export class RetainedResource<T> {
  private value: T | null = null;
  private pending: Promise<T | null> | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private release: (value: T) => void) {}
  get closed() {
    return this.disposed;
  }
  acquire(create: () => Promise<T>): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.value) return Promise.resolve(this.value);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(() => {
        if (this.disposed || generation !== this.generation) return null;
        return create();
      })
      .then((value) => {
        if (value === null) return null;
        if (this.disposed || generation !== this.generation) {
          this.release(value);
          return null;
        }
        this.value = value;
        return value;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
  clear() {
    this.generation++;
    const value = this.value;
    this.value = null;
    this.pending = null;
    if (value !== null) this.release(value);
  }
  dispose() {
    this.disposed = true;
    this.clear();
  }
}
