import { DoubleSide, MeshDepthMaterial, RGBADepthPacking } from "three";
import { PARTICLE_DEFINES } from "../../miscellaneous/miscellaneous";
import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../../nodes/FXNode";
import type { FXNodeColor } from "../../nodes/color/FXNodeColor";
import type { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";

const DEPTH_VERTEX_SHADER = `
  #define PARTICLE_POSITION_X a_builtin[0][0]
  #define PARTICLE_POSITION_Y a_builtin[0][1]
  #define PARTICLE_POSITION_Z a_builtin[0][2]

  #define PARTICLE_SCALE_X a_builtin[1][2]
  #define PARTICLE_SCALE_Y a_builtin[1][3]

  #define PARTICLE_ROTATION a_builtin[2][1]

  attribute mat4 a_builtin;
  varying mat4 p_builtin;
  varying vec2 p_uv;
  varying vec2 vHighPrecisionZW;
  varying float vCenterViewZ;

  #ifdef USE_ALPHAHASH
    varying vec3 vPosition;
  #endif

  void main() {
    p_builtin = a_builtin;
    p_uv = uv;

    #ifdef USE_ALPHAHASH
      vPosition = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z) + vec3(position.xy, 0.0);
    #endif

    vec2 billboardOffset = position.xy;
    billboardOffset.x *= PARTICLE_SCALE_X;
    billboardOffset.y *= PARTICLE_SCALE_Y;

    float cosRotation = cos(PARTICLE_ROTATION);
    float sinRotation = sin(PARTICLE_ROTATION);
    billboardOffset = vec2(
      billboardOffset.x * cosRotation - billboardOffset.y * sinRotation,
      billboardOffset.x * sinRotation + billboardOffset.y * cosRotation
    );

    vec3 particleCenter = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z);
    vec4 modelViewPosition = modelViewMatrix * vec4(particleCenter, 1.0);
    vCenterViewZ = modelViewPosition.z;
    modelViewPosition.xy += billboardOffset;
    gl_Position = projectionMatrix * modelViewPosition;
    vHighPrecisionZW = gl_Position.zw;
  }
`;

/**
 * GLSL snippet that replaces the flat `fragCoordZ` with a spherical depth
 * approximation. Treats each billboard as the front hemisphere of a sphere
 * whose radius equals half the smaller particle scale dimension. Fragments
 * outside that radius are discarded, producing a circular silhouette.
 *
 * Expects `vCenterViewZ` (view-space Z of the particle center), `p_uv`,
 * `PARTICLE_SCALE_X / Y`, and `projectionMatrix` to be available.
 */
const SPHERICAL_DEPTH_FRAG_COORD_Z = `
  float sphereOffsetX = (p_uv.x - 0.5) * PARTICLE_SCALE_X;
  float sphereOffsetY = (p_uv.y - 0.5) * PARTICLE_SCALE_Y;
  float sphereRadius = min(PARTICLE_SCALE_X, PARTICLE_SCALE_Y) * 0.5;
  float squaredDistanceFromCenter = sphereOffsetX * sphereOffsetX + sphereOffsetY * sphereOffsetY;
  if (squaredDistanceFromCenter > sphereRadius * sphereRadius) discard;

  float sphereViewZ = vCenterViewZ + sqrt(sphereRadius * sphereRadius - squaredDistanceFromCenter);
  float projectedZ = projectionMatrix[2][2] * sphereViewZ + projectionMatrix[3][2];
  float projectedW = projectionMatrix[2][3] * sphereViewZ + projectionMatrix[3][3];
  float normalizedDeviceZ = projectedZ / projectedW;

  #ifdef USE_REVERSEDEPTHBUF
    float fragCoordZ = normalizedDeviceZ;
  #else
    float fragCoordZ = 0.5 * normalizedDeviceZ + 0.5;
  #endif
`;

const FRAG_COORD_Z_PATTERN = /float fragCoordZ\b[^;]*;/;

export function buildDepthMaterial(
  albedoNodes: readonly (FXNodeColor | FXNodeTexture)[],
  depthAlphaTest: number,
  useDepthAlphaHash: boolean,
  useSphericalDepth: boolean,
): MeshDepthMaterial {
  const depthNodes = albedoNodes.filter((node): boolean => node.affectsDepth);
  const needsFragmentPatch = depthNodes.length > 0 || useSphericalDepth;

  const material = new MeshDepthMaterial({
    name: "FXDepthMaterial",
    depthPacking: RGBADepthPacking,
    side: DoubleSide,
    forceSinglePass: true,
    alphaHash: useDepthAlphaHash,
  });

  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = DEPTH_VERTEX_SHADER;

    if (!needsFragmentPatch) {
      return;
    }

    const seenCacheKeys = new Set<string>();
    const uniqueHelpers = depthNodes
      .filter((node) => {
        if (seenCacheKeys.has(node.cacheKey)) {
          return false;
        }
        seenCacheKeys.add(node.cacheKey);
        return true;
      })
      .map((node) => node.helperFunctions)
      .join("\n");

    const fragmentPreamble = [
      PARTICLE_DEFINES,
      "varying mat4 p_builtin;",
      "varying vec2 p_uv;",
      "varying float vCenterViewZ;",
      useSphericalDepth ? "uniform mat4 projectionMatrix;" : "",
      depthNodes.flatMap((node) => node.uniformDeclarations).join("\n"),
      uniqueHelpers,
    ].join("\n");

    for (const node of depthNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }

    let fragmentShader = shader.fragmentShader;

    if (depthNodes.length > 0) {
      const albedoLines = ["vec4 fxDepthAlbedo = vec4(1.0);"];
      for (const node of depthNodes) {
        albedoLines.push(
          `fxDepthAlbedo = ${node.colorExpression.replace(CURRENT_EXPRESSION_VALUE_PLACEHOLDER, "fxDepthAlbedo")};`,
        );
      }
      albedoLines.push(`diffuseColor.a = fxDepthAlbedo.a;`);
      albedoLines.push(`if (diffuseColor.a < ${depthAlphaTest.toFixed(4)}) discard;`);
      fragmentShader = fragmentShader.replace("#include <map_fragment>", albedoLines.join("\n"));
    }

    if (useSphericalDepth) {
      if (!FRAG_COORD_Z_PATTERN.test(fragmentShader)) {
        console.warn(
          "FXDepthMaterial: could not find 'float fragCoordZ' in the depth fragment shader. " +
            "Spherical depth will not be applied. " +
            "This may indicate a Three.js version mismatch.",
        );
      } else {
        fragmentShader = fragmentShader.replace(FRAG_COORD_Z_PATTERN, SPHERICAL_DEPTH_FRAG_COORD_Z);
      }
    }

    shader.fragmentShader = fragmentPreamble + "\n" + fragmentShader;
  };

  material.customProgramCacheKey = (): string =>
    `fx-depth-${useDepthAlphaHash ? "alphaHash" : "alphaTest"}-${useSphericalDepth ? "spherical" : "flat"}-${depthNodes.map((node) => node.cacheKey).join("-") || "none"}`;

  return material;
}
