import {
  BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER,
  CURRENT_EXPRESSION_VALUE_PLACEHOLDER,
} from "../../nodes/FXNode";
import { FXNodeBlending } from "../../nodes/blending/FXNodeBlending";
import type { FXNodeColor } from "../../nodes/color/FXNodeColor";
import type { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";
import { FXBlending } from "./FXMaterial";

export interface AlbedoBlendingCode {
  /** Replacement for #include <map_fragment>. null means: leave the include as-is */
  mapFragment: string | null;
  /** Replacement for #include <premultiplied_alpha_fragment> */
  premultChunk: string;
}

/**
 * Processes albedoNodes in order to produce shader code for both the color assignment
 * and the per-pixel blending mode.
 *
 * Nodes are composed sequentially: each node receives the current accumulated value via
 * EXPRESSION_CURRENT_VALUE_PLACEHOLDER and returns a new value. Nodes that do not use
 * the placeholder act as sources and replace the current value entirely.
 *
 * When a FXNodeBlending appears, it receives both the current mask (via
 * EXPRESSION_CURRENT_VALUE_PLACEHOLDER) and the current color (via
 * EXPRESSION_CURRENT_COLOR_PLACEHOLDER), and returns the new mask value. Color nodes
 * that follow a blending node do not affect the mask.
 */
export function buildAlbedoAndBlendingCode(
  albedoNodes: readonly (FXNodeColor | FXNodeTexture | FXNodeBlending)[],
  blending: FXBlending,
  useAlphaHashing: boolean,
): AlbedoBlendingCode {
  if (albedoNodes.length === 0) {
    return { mapFragment: null, premultChunk: buildPremultChunk(blending, false) };
  }

  const hasBlendingNodes = albedoNodes.some((node) => node instanceof FXNodeBlending);
  const lines: string[] = [];

  lines.push("vec4 fxAlbedo = vec4(1.0);");
  if (hasBlendingNodes) {
    lines.push("float fxBlendMask = 1.0;");
  }

  for (const node of albedoNodes) {
    if (node instanceof FXNodeBlending) {
      lines.push(
        `fxBlendMask = ${node.blendingExpression
          .replace(CURRENT_EXPRESSION_VALUE_PLACEHOLDER, "fxBlendMask")
          .replace(BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER, "fxAlbedo")};`,
      );
    } else {
      lines.push(
        `fxAlbedo = ${node.colorExpression.replace(CURRENT_EXPRESSION_VALUE_PLACEHOLDER, "fxAlbedo")};`,
      );
    }
  }

  const discardLine = useAlphaHashing ? "" : "if (diffuseColor.a < 0.0035) discard;";
  lines.push(`diffuseColor = fxAlbedo; ${discardLine}`);

  return {
    mapFragment: lines.join("\n"),
    premultChunk: buildPremultChunk(blending, hasBlendingNodes),
  };
}

function buildPremultChunk(blending: FXBlending, hasBlendingNodes: boolean): string {
  if (!hasBlendingNodes) {
    return `gl_FragColor.rgb *= gl_FragColor.a;`;
  }

  if (blending === FXBlending.MASKED_ADDITIVE) {
    return `
      gl_FragColor.rgb *= gl_FragColor.a;
      gl_FragColor.a *= (1.0 - clamp(fxBlendMask, 0.0, 1.0));
    `;
  }

  // MASKED_MULTIPLY: dark areas darken destination, bright areas normal-blend
  return `
    gl_FragColor.rgb *= gl_FragColor.a;
    float fxLumPremult = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec4 fxMultiply = vec4(0.0, 0.0, 0.0, gl_FragColor.a - fxLumPremult);
    gl_FragColor = mix(gl_FragColor, fxMultiply, clamp(fxBlendMask, 0.0, 1.0));
  `;
}
