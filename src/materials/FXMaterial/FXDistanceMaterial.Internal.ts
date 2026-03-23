import { DoubleSide, MeshDistanceMaterial } from "three";
import { PARTICLE_DEFINES } from "../../miscellaneous/miscellaneous";
import type { FXNodeColor } from "../../nodes/color/FXNodeColor";
import type { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";

/**
 * Custom vertex shader for point/spot light shadow maps.
 *
 * Unlike the depth material (which writes clip-space Z for directional light
 * shadows), the distance material writes the world-space distance from each
 * fragment to the light position. This means we need to reconstruct world
 * position for each billboarded vertex.
 *
 * `vWorldPosition` is a Three.js convention consumed by the distance fragment
 * shader. `viewMatrix` here is the shadow camera's view matrix, so the
 * billboard faces the light - which is correct for shadow shape.
 */
const DISTANCE_VERTEX_SHADER = `
  #define DISTANCE

  #define PARTICLE_POSITION_X a_builtin[0][0]
  #define PARTICLE_POSITION_Y a_builtin[0][1]
  #define PARTICLE_POSITION_Z a_builtin[0][2]

  #define PARTICLE_SCALE_X a_builtin[1][2]
  #define PARTICLE_SCALE_Y a_builtin[1][3]

  #define PARTICLE_ROTATION a_builtin[2][1]

  attribute mat4 a_builtin;
  varying mat4 p_builtin;
  varying vec2 p_uv;
  varying vec3 vWorldPosition;

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

    // Reconstruct world-space position for the billboarded vertex.
    // Camera axes are extracted from the shadow camera's view matrix (transposed
    // rotation part), then scaled by the billboard offset.
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 worldCenter = (modelMatrix * vec4(particleCenter, 1.0)).xyz;
    vWorldPosition = worldCenter + cameraRight * billboardOffset.x + cameraUp * billboardOffset.y;

    // Standard clip-space projection via the shadow camera.
    vec4 modelViewPosition = modelViewMatrix * vec4(particleCenter, 1.0);
    modelViewPosition.xy += billboardOffset;
    gl_Position = projectionMatrix * modelViewPosition;
  }
`;

/**
 * GLSL snippet for spherical distance adjustment.
 *
 * Instead of measuring distance from the flat billboard surface, this
 * approximates the front hemisphere of a sphere. The sphere radius is half
 * the smaller scale dimension. Fragments outside the sphere are discarded.
 *
 * The depth offset is subtracted from the flat distance, bringing the
 * perceived surface closer to the light. This is an approximation - the
 * true offset direction depends on the light-to-fragment vector, not the
 * camera-to-fragment vector - but for smoke particles the error is
 * negligible.
 */
const SPHERICAL_DISTANCE_SNIPPET = `
  {
    float sphereOffsetX = (p_uv.x - 0.5) * PARTICLE_SCALE_X;
    float sphereOffsetY = (p_uv.y - 0.5) * PARTICLE_SCALE_Y;
    float sphereRadius = min(PARTICLE_SCALE_X, PARTICLE_SCALE_Y) * 0.5;
    float squaredDistanceFromCenter = sphereOffsetX * sphereOffsetX + sphereOffsetY * sphereOffsetY;
    if (squaredDistanceFromCenter > sphereRadius * sphereRadius) discard;
    float sphereDepthOffset = sqrt(sphereRadius * sphereRadius - squaredDistanceFromCenter);
    dist = max(0.0, dist - sphereDepthOffset);
  }
`;

const DISTANCE_CALCULATION_PATTERN =
  /float\s+dist\s*=\s*length\s*\(\s*vWorldPosition\s*-\s*referencePosition\s*\)\s*;/;

export function buildDistanceMaterial(
  albedoNodes: readonly (FXNodeColor | FXNodeTexture)[],
  distanceAlphaTest: number,
  useDistanceAlphaHash: boolean,
  useSphericalDepth: boolean,
): MeshDistanceMaterial {
  const distanceNodes = albedoNodes.filter((node): boolean => node.affectsDepth);
  const needsFragmentPatch = distanceNodes.length > 0 || useSphericalDepth;

  const material = new MeshDistanceMaterial({
    name: "FXDistanceMaterial",
    side: DoubleSide,
    forceSinglePass: true,
    alphaHash: useDistanceAlphaHash,
  });

  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = DISTANCE_VERTEX_SHADER;

    if (!needsFragmentPatch) {
      return;
    }

    const seenCacheKeys = new Set<string>();
    const uniqueHelpers = distanceNodes
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
      distanceNodes.flatMap((node) => node.uniformDeclarations).join("\n"),
      uniqueHelpers,
    ].join("\n");

    for (const node of distanceNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }

    let fragmentShader = shader.fragmentShader;

    // Alpha from nodes - MeshDistanceMaterial may or may not include
    // <map_fragment> depending on the Three.js version. If the chunk is
    // absent, insert the alpha discard before the distance calculation.
    if (distanceNodes.length > 0) {
      const combinedAlphaExpression = distanceNodes.map((node) => node.colorExpression).join(" * ");
      const alphaDiscardCode =
        `float nodeAlpha = (${combinedAlphaExpression}).a;\n` +
        `if (nodeAlpha < ${distanceAlphaTest.toFixed(4)}) discard;`;

      if (fragmentShader.includes("#include <map_fragment>")) {
        fragmentShader = fragmentShader.replace("#include <map_fragment>", alphaDiscardCode);
      } else if (DISTANCE_CALCULATION_PATTERN.test(fragmentShader)) {
        // Fallback: inject alpha discard just before the distance calculation.
        fragmentShader = fragmentShader.replace(
          DISTANCE_CALCULATION_PATTERN,
          (match) => alphaDiscardCode + "\n" + match,
        );
      } else {
        console.warn(
          "FXDistanceMaterial: could not find a suitable injection point for alpha discard. " +
            "This may indicate a Three.js version mismatch.",
        );
      }
    }

    // Spherical distance adjustment - offset the flat-billboard distance by
    // the sphere's front surface depth.
    if (useSphericalDepth) {
      if (!DISTANCE_CALCULATION_PATTERN.test(fragmentShader)) {
        console.warn(
          "FXDistanceMaterial: could not find the distance calculation line. " +
            "Spherical depth will not be applied. " +
            "This may indicate a Three.js version mismatch.",
        );
      } else {
        // Inject the spherical adjustment right after the distance calculation.
        fragmentShader = fragmentShader.replace(
          DISTANCE_CALCULATION_PATTERN,
          (match) => match + "\n" + SPHERICAL_DISTANCE_SNIPPET,
        );
      }
    }

    shader.fragmentShader = fragmentPreamble + "\n" + fragmentShader;
  };

  material.customProgramCacheKey = (): string =>
    `fx-distance-${useDistanceAlphaHash ? "alphaHash" : "alphaTest"}-${useSphericalDepth ? "spherical" : "flat"}-${distanceNodes.map((node) => node.cacheKey).join("-") || "none"}`;

  return material;
}
