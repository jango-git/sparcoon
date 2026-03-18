export abstract class FXColorNode {
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

  public destroy?(): void;
}
