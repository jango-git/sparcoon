import { FXNodeNormal } from "./FXNodeNormal";

/**
 * Normal node that outputs a constant face-aligned normal pointing toward the camera
 */
export class FXNodeFlatNormal extends FXNodeNormal {
  /** @internal */
  public override readonly cacheKey: string;
  /** @internal */
  public override readonly uniformDeclarations: string[];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions: string;
  /** @internal */
  public override readonly normalExpression: string;

  constructor() {
    super();

    this.cacheKey = "flat-normal";
    this.uniformDeclarations = [];
    this.uniforms = {};
    this.helperFunctions = "";
    this.normalExpression = "vec3(0.0, 0.0, 1.0)";
  }
}
