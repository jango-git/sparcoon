import type { Texture } from "three";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { FXTextureNode } from "./FXTextureNode";

export class FXStaticTextureNode extends FXTextureNode {
  /** @internal */
  public override readonly affectsDepth: boolean;
  /** @internal */
  public override readonly cacheKey: string;
  /** @internal */
  public override readonly uniformDeclarations: string[];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions: string;
  /** @internal */
  public override readonly colorExpression: string;

  constructor(texture: Texture) {
    super();

    this.affectsDepth = true;
    this.cacheKey = "static";
    this.uniformDeclarations = ["uniform sampler2D u_StaticTexture;"];
    this.uniforms = {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      u_StaticTexture: { value: texture },
    };
    this.helperFunctions = `
      vec4 sampleStaticTexture(sampler2D colorTexture, vec2 uv) {
        vec4 color = texture2D(colorTexture, uv);
        // Apply gamma correction when sRGB textures are not natively supported
        ${checkSRGBSupport() ? "" : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);"}
        return color;
      }
    `;
    this.colorExpression = "sampleStaticTexture(u_StaticTexture, p_uv)";
  }
}
