/**
 * @internal One holder's claim on a GL resource shared by every holder of the same key on the same
 * context: made on the first claim, deleted when the last claim is released.
 */
export interface FXContextLease<R> {
  readonly resource: R;
  /** Gives the claim up; a second call is a no-op. */
  release(): void;
}

interface FXContextLeaseEntry<R> {
  readonly resource: R;
  users: number;
}

/**
 * @internal GL resources shared by key within each context. A lost context takes its resources
 * with it, so its entries are dropped: a context restored under the same object makes them anew.
 */
export class FXContextLeases<K, R> {
  private readonly entriesByContext = new WeakMap<
    WebGL2RenderingContext,
    Map<K, FXContextLeaseEntry<R>>
  >();

  /** `dispose` deletes a resource no claim holds any longer. */
  constructor(private readonly dispose: (gl: WebGL2RenderingContext, resource: R) => void) {}

  /** A claim on the resource of `key` on `gl`, made by `create` when there is none yet. */
  public acquire(gl: WebGL2RenderingContext, key: K, create: () => R): FXContextLease<R> {
    const entries = this.entriesOf(gl);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { resource: create(), users: 0 };
      entries.set(key, entry);
    }
    const claimed = entry;
    claimed.users += 1;
    let released = false;
    return {
      resource: claimed.resource,
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        claimed.users -= 1;
        // Past a context loss the entry is no longer in the map, and its resource is already gone.
        if (claimed.users === 0 && entries.get(key) === claimed) {
          entries.delete(key);
          this.dispose(gl, claimed.resource);
        }
      },
    };
  }

  private entriesOf(gl: WebGL2RenderingContext): Map<K, FXContextLeaseEntry<R>> {
    const known = this.entriesByContext.get(gl);
    if (known !== undefined) {
      return known;
    }
    const entries = new Map<K, FXContextLeaseEntry<R>>();
    this.entriesByContext.set(gl, entries);
    gl.canvas.addEventListener("webglcontextlost", () => {
      entries.clear();
    });
    return entries;
  }
}
