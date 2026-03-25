export const CURRENT_EXPRESSION_VALUE_PLACEHOLDER = "CURRENT_EXPRESSION_VALUE_PLACEHOLDER";
export const BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER =
  "BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER";

export abstract class FXNode {
  /** @internal */
  public readonly uniforms?: Record<string, { value: unknown }>;
  /** @internal */
  public readonly uniformDeclarations?: string[];
  /** @internal */
  public readonly helperFunctions?: string;
  /** @internal */
  public readonly affectsDepth: boolean = false;
  /** @internal */
  public abstract readonly cacheKey: string;

  public destroy?(): void;
}
