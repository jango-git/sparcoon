import { DoubleSide, MeshDepthMaterial, RGBADepthPacking } from "three";
import type { FXColorNode } from "./color-nodes/FXColorNode";
import { PARTICLE_DEFINES } from "./miscellaneous";

export const DEPTH_VERTEX_SHADER = `
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
  varying float v_viewZ;
  #ifdef USE_ALPHAHASH
    varying vec3 vPosition;
  #endif

  void main() {
    p_builtin = a_builtin;
    p_uv = uv;
    #ifdef USE_ALPHAHASH
      vPosition = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z) + vec3(position.xy, 0.0);
    #endif

    vec2 transformedPosition = position.xy;
    transformedPosition.x *= PARTICLE_SCALE_X;
    transformedPosition.y *= PARTICLE_SCALE_Y;

    float cosR = cos(PARTICLE_ROTATION);
    float sinR = sin(PARTICLE_ROTATION);
    transformedPosition = vec2(
      transformedPosition.x * cosR - transformedPosition.y * sinR,
      transformedPosition.x * sinR + transformedPosition.y * cosR
    );

    vec3 center = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z);
    vec4 modelViewCenter = modelViewMatrix * vec4(center, 1.0);
    v_viewZ = modelViewCenter.z;
    modelViewCenter.xy += transformedPosition;
    gl_Position = projectionMatrix * modelViewCenter;
    vHighPrecisionZW = gl_Position.zw;
  }
`;

const DEPTH_SPHERICAL_FRAG_COORD_Z = `
  float _dx = (p_uv.x - 0.5) * PARTICLE_SCALE_X;
  float _dy = (p_uv.y - 0.5) * PARTICLE_SCALE_Y;
  float _r = min(PARTICLE_SCALE_X, PARTICLE_SCALE_Y) * 0.5;
  float _d2 = _dx * _dx + _dy * _dy;
  if (_d2 > _r * _r) discard;
  float _sphereZ = v_viewZ + sqrt(_r * _r - _d2);
  float _pz = projectionMatrix[2][2] * _sphereZ + projectionMatrix[3][2];
  float _pw = projectionMatrix[2][3] * _sphereZ + projectionMatrix[3][3];
  float _ndc_z = _pz / _pw;
  #ifdef USE_REVERSEDEPTHBUF
    float fragCoordZ = _ndc_z;
  #else
    float fragCoordZ = 0.5 * _ndc_z + 0.5;
  #endif
`;

export function buildDepthMaterial(
  colorNodes: readonly FXColorNode[],
  depthAlphaTest: number,
  useDepthAlphaHash: boolean,
  useSphericalDepth: boolean,
): MeshDepthMaterial {
  const depthNodes = colorNodes.filter((n): boolean => n.affectsDepth);
  const needsFragmentMod = depthNodes.length > 0 || useSphericalDepth;

  const material = new MeshDepthMaterial({
    depthPacking: RGBADepthPacking,
    side: DoubleSide,
    forceSinglePass: true,
    alphaHash: useDepthAlphaHash,
  });

  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = DEPTH_VERTEX_SHADER;

    if (!needsFragmentMod) {
      return;
    }

    const fragmentPreamble = [
      PARTICLE_DEFINES,
      "varying mat4 p_builtin;",
      "varying vec2 p_uv;",
      "varying float v_viewZ;",
      useSphericalDepth ? "uniform mat4 projectionMatrix;" : "",
      depthNodes.flatMap((n) => n.uniformDeclarations).join("\n"),
      depthNodes.map((n) => n.helperFunctions).join("\n"),
    ].join("\n");

    for (const node of depthNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }

    let fs = shader.fragmentShader;

    if (depthNodes.length > 0) {
      const combinedAlpha = depthNodes.map((n) => n.colorExpression).join(" * ");
      fs = fs.replace(
        "#include <map_fragment>",
        `diffuseColor.a = (${combinedAlpha}).a;
         if (diffuseColor.a < ${depthAlphaTest.toFixed(4)}) discard;`,
      );
    }

    if (useSphericalDepth) {
      fs = fs.replace(/float fragCoordZ\b[^;]*;/, DEPTH_SPHERICAL_FRAG_COORD_Z);
    }

    shader.fragmentShader = fragmentPreamble + "\n" + fs;
  };

  material.customProgramCacheKey = (): string =>
    `fx-depth-${useDepthAlphaHash ? "ah" : "at"}-${useSphericalDepth ? "sd" : "flat"}-${depthNodes.map((n) => n.cacheKey).join("-") || "none"}`;

  return material;
}
