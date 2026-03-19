import type { Texture } from "three";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { FXTextureNode } from "./FXTextureNode";

const INSTANCES: FXStaticTextureNode[] = [];

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
    INSTANCES.push(this);
    const uniformName = `u_StaticTexture_${INSTANCES.length - 1}`;

    this.affectsDepth = true;
    this.cacheKey = "static";
    this.uniformDeclarations = [`uniform sampler2D ${uniformName};`];
    this.uniforms = {
      [uniformName]: { value: texture },
    };
    this.helperFunctions = `
      vec4 sampleStaticTexture(sampler2D colorTexture, vec2 uv) {
        vec4 color = texture2D(colorTexture, uv);
        // Apply gamma correction when sRGB textures are not natively supported
        ${checkSRGBSupport() ? "" : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);"}
        return color;
      }
    `;
    this.colorExpression = `sampleStaticTexture(${uniformName}, p_uv)`;
  }

  public override destroy(): void {
    const index = INSTANCES.indexOf(this);
    if (index !== -1) {
      INSTANCES.splice(index, 1);
    }
  }
}
