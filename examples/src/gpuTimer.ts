import type { WebGLRenderer } from "three";

interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface Pending {
  readonly pass: string;
  readonly query: WebGLQuery;
}

/**
 * The GPU time of named passes, from WebGL2 timer queries (`EXT_disjoint_timer_query_webgl2`).
 * Results arrive some frames late; each pass gathers them until {@link take} averages and clears
 * them. Without the extension (WebGL1, or a browser that hides it) it measures nothing.
 */
export class GpuTimer {
  private readonly gl: WebGL2RenderingContext | undefined;
  private readonly extension: TimerQueryExtension | undefined;
  private readonly pending: Pending[] = [];
  private readonly spare: WebGLQuery[] = [];
  private readonly totals = new Map<string, { milliseconds: number; count: number }>();

  public constructor(renderer: WebGLRenderer) {
    const context = renderer.getContext();
    if (context instanceof WebGL2RenderingContext) {
      const extension = context.getExtension(
        "EXT_disjoint_timer_query_webgl2",
      ) as TimerQueryExtension | null;
      if (extension !== null) {
        this.gl = context;
        this.extension = extension;
      }
    }
  }

  /** Runs `body` and times the GPU work it issues as `pass`. */
  public measure(pass: string, body: () => void): void {
    const { gl, extension } = this;
    if (gl === undefined || extension === undefined) {
      body();
      return;
    }
    const query = this.spare.pop() ?? gl.createQuery()!;
    gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    body();
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    this.pending.push({ pass, query });
  }

  /** Adds the results that have arrived to their passes. A disjoint GPU (a power or clock change)
   *  voids every query in flight, so those are dropped. */
  public collect(): void {
    const { gl, extension } = this;
    if (gl === undefined || extension === undefined) {
      return;
    }
    const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length > 0) {
      const { pass, query } = this.pending[0]!;
      if (!disjoint && !(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean)) {
        break;
      }
      if (!disjoint) {
        const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
        const total = this.totals.get(pass) ?? { milliseconds: 0, count: 0 };
        total.milliseconds += nanoseconds / 1e6;
        total.count += 1;
        this.totals.set(pass, total);
      }
      this.pending.shift();
      this.spare.push(query);
    }
  }

  /** Each pass's mean milliseconds since the last call. */
  public take(): Map<string, number> {
    const means = new Map<string, number>();
    for (const [pass, { milliseconds, count }] of this.totals) {
      means.set(pass, milliseconds / count);
    }
    this.totals.clear();
    return means;
  }
}
