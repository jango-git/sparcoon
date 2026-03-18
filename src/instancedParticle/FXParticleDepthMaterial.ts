import { MeshDepthMaterial, RGBADepthPacking } from "three";

const PARTICLE_DEPTH_VERTEX_SHADER = `
  #define PARTICLE_POSITION_X a_builtin[0][0]
  #define PARTICLE_POSITION_Y a_builtin[0][1]
  #define PARTICLE_POSITION_Z a_builtin[0][2]

  #define PARTICLE_SCALE_X a_builtin[1][2]
  #define PARTICLE_SCALE_Y a_builtin[1][3]

  #define PARTICLE_ROTATION a_builtin[2][1]

  attribute mat4 a_builtin;

  varying vec2 vHighPrecisionZW;

  void main() {
    vec2 transformedPosition = position.xy;

    transformedPosition.x *= PARTICLE_SCALE_X;
    transformedPosition.y *= PARTICLE_SCALE_Y;

    float cosR = cos(PARTICLE_ROTATION);
    float sinR = sin(PARTICLE_ROTATION);

    transformedPosition = vec2(
      transformedPosition.x * cosR - transformedPosition.y * sinR,
      transformedPosition.x * sinR + transformedPosition.y * cosR
    );

    vec3 center = vec3(
      PARTICLE_POSITION_X,
      PARTICLE_POSITION_Y,
      PARTICLE_POSITION_Z
    );

    vec4 modelViewCenter = modelViewMatrix * vec4(center, 1.0);
    modelViewCenter.xy += transformedPosition;
    gl_Position = projectionMatrix * modelViewCenter;
    vHighPrecisionZW = gl_Position.zw;
  }
`;

export function buildParticleDepthMaterial(): MeshDepthMaterial {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = PARTICLE_DEPTH_VERTEX_SHADER;
  };

  material.customProgramCacheKey = (): string => "fx-particle-depth";

  return material;
}
