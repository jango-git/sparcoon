import type { Texture } from "three";
import { FXColorNode } from "./FXColorNode";

export class FXStaticTextureNode extends FXColorNode {
  /** @internal */
  public override readonly cacheKey = "static";
  /** @internal */
  public override readonly uniformDeclarations = ["uniform sampler2D u_StaticTexture;"];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions = "";
  /** @internal */
  public override readonly colorExpression = "texture2D(u_StaticTexture, p_uv)";
  /** @internal */
  public override readonly affectsDepth = true;

  constructor(texture: Texture) {
    super();
    this.uniforms = {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      u_StaticTexture: { value: texture },
    };
  }
}
