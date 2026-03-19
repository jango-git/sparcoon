export abstract class FXNormalNode {
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

  public destroy?(): void;
}
