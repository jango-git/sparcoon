import { FXColorNode } from "./FXColorNode";

const INSTANCES: FXSphericalClipNode[] = [];

export class FXSphericalClipNode extends FXColorNode {
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

  constructor(innerRadius = 0.5) {
    super();
    INSTANCES.push(this);
    const uniformName = `u_SphericalClip_${INSTANCES.length - 1}`;

    this.cacheKey = "spherical-clip";
    this.uniformDeclarations = [`uniform float ${uniformName};`];
    this.uniforms = {
      [uniformName]: { value: innerRadius },
    };
    this.helperFunctions = `
      vec4 applySphericalClip(float innerRadius) {
        float distanceToCenter = distance(p_uv, vec2(0.5, 0.5));
        return vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(innerRadius, 0.5, distanceToCenter));
      }
    `;
    this.colorExpression = `applySphericalClip(${uniformName})`;
  }

  public override destroy(): void {
    const index = INSTANCES.indexOf(this);
    if (index !== -1) {
      INSTANCES.splice(index, 1);
    }
  }
}
