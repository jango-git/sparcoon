/**
 * Abstract base class for particle normal nodes
 */
export abstract class FXNodeNormal {
  /** @internal */
  public abstract readonly cacheKey: string;
  /** @internal */
  public abstract readonly uniformDeclarations: string[];
  /** @internal */
  public abstract readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public abstract readonly helperFunctions: string;
  /** @internal */
  public abstract readonly normalExpression: string;

  /** Releases any GPU resources held by this node */
  public destroy?(): void;
}
