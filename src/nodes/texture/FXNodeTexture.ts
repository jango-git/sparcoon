/**
 * Abstract base class for particle texture nodes
 */
export abstract class FXNodeTexture {
  /** @internal */
  public readonly affectsDepth: boolean = false;
  /** @internal */
  public abstract readonly cacheKey: string;
  /** @internal */
  public abstract readonly uniformDeclarations: string[];
  /** @internal */
  public abstract readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public abstract readonly helperFunctions: string;
  /** @internal */
  public abstract readonly colorExpression: string;

  /** Releases any GPU resources held by this node */
  public destroy?(): void;
}
