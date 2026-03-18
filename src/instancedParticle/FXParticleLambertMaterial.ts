import { MeshLambertMaterial, type Blending } from "three";
import { FXColor } from "../color/FXColor";
import { checkSRGBSupport } from "../miscellaneous/webglCapabilities";
import { FXParticleNormalsMode } from "./FXParticleNormalsMode";
import type { GLProperty, GLTypeInfo } from "./shared";

const PARTICLE_DEFINES = `
  #define PARTICLE_POSITION_X p_builtin[0][0]
  #define PARTICLE_POSITION_Y p_builtin[0][1]
  #define PARTICLE_POSITION_Z p_builtin[0][2]

  #define PARTICLE_VELOCITY_X p_builtin[0][3]
  #define PARTICLE_VELOCITY_Y p_builtin[1][0]
  #define PARTICLE_VELOCITY_Z p_builtin[1][1]

  #define PARTICLE_SCALE_X p_builtin[1][2]
  #define PARTICLE_SCALE_Y p_builtin[1][3]
  #define PARTICLE_SCALE_Z p_builtin[2][0]

  #define PARTICLE_ROTATION p_builtin[2][1]
  #define PARTICLE_TORQUE p_builtin[2][2]

  #define PARTICLE_LIFETIME p_builtin[2][3]
  #define PARTICLE_AGE p_builtin[3][0]

  #define PARTICLE_RANDOM_A p_builtin[3][1]
  #define PARTICLE_RANDOM_B p_builtin[3][2]
  #define PARTICLE_RANDOM_C p_builtin[3][3]
`;

export function buildParticleLambertMaterial(
  sources: string[],
  uniformProperties: Record<string, GLProperty>,
  varyingProperties: Record<string, GLTypeInfo>,
  blending: Blending,
  useAlphaHashing: boolean,
  normalsMode: FXParticleNormalsMode,
): MeshLambertMaterial {
  const uniformValues: Record<string, { value: unknown }> = {};
  const uniformDeclarations: string[] = [];
  const attributeDeclarations: string[] = [];
  const varyingDeclarations: string[] = [];
  const vertexAssignments: string[] = [];

  for (const name in uniformProperties) {
    const { value, glslTypeInfo } = uniformProperties[name];
    uniformValues[`p_${name}`] = { value: value instanceof FXColor ? value.toGLSLColor() : value };
    uniformDeclarations.push(`uniform ${glslTypeInfo.glslTypeName} p_${name};`);
  }

  for (const name in varyingProperties) {
    const { glslTypeName } = varyingProperties[name];
    attributeDeclarations.push(`attribute ${glslTypeName} a_${name};`);
    varyingDeclarations.push(`varying ${glslTypeName} p_${name};`);
    vertexAssignments.push(`p_${name} = a_${name};`);
  }

  const renamedSources = sources.map((source, index) =>
    source.replace(/vec4\s+draw\s*\(\s*\)/g, `vec4 draw${index}()`),
  );

  let drawCalls = "";
  for (let i = 0; i < sources.length; i++) {
    drawCalls += i !== 0 ? " * " : "";
    drawCalls += `draw${i}()`;
  }

  const srgbSupported = checkSRGBSupport() ? "1" : "0";

  const srgbHelper = `
    vec4 srgbTexture2D(sampler2D textureSampler, vec2 uv) {
      #if SRGB_SUPPORTED
        return texture2D(textureSampler, uv);
      #else
        vec4 textureValue = texture2D(textureSampler, uv);
        return vec4(pow(textureValue.rgb, vec3(2.2)), textureValue.a);
      #endif
    }
  `;

  const material = new MeshLambertMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    alphaHash: useAlphaHashing,
    blending,
  });

  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniformValues);

    // --- Vertex shader ---

    const vertexPreamble = [
      PARTICLE_DEFINES,
      attributeDeclarations.join("\n"),
      "varying vec2 p_uv;",
      varyingDeclarations.join("\n"),
    ].join("\n");

    shader.vertexShader =
      vertexPreamble +
      "\n" +
      shader.vertexShader
        // Hardcode objectNormal — no normal attribute on billboard geometry
        .replace(
          "#include <beginnormal_vertex>",
          "vec3 objectNormal = vec3(0.0, 0.0, 1.0);",
        )
        // Hardcode transformedNormal as view-space camera-facing (0,0,1)
        .replace(
          "#include <defaultnormal_vertex>",
          "vec3 transformedNormal = vec3(0.0, 0.0, 1.0);",
        )
        // Set p_uv, user varyings, placeholder transformed for downstream chunks
        .replace(
          "#include <begin_vertex>",
          ["p_uv = uv;", vertexAssignments.join("\n"), "vec3 transformed = position;"].join("\n"),
        )
        // Billboard projection: computes p_bp (screen offset) and p_c (center), sets mvPosition
        .replace(
          "#include <project_vertex>",
          `
          vec2 p_bp = position.xy;
          p_bp.x *= PARTICLE_SCALE_X;
          p_bp.y *= PARTICLE_SCALE_Y;
          float p_cosR = cos(PARTICLE_ROTATION);
          float p_sinR = sin(PARTICLE_ROTATION);
          p_bp = vec2(
            p_bp.x * p_cosR - p_bp.y * p_sinR,
            p_bp.x * p_sinR + p_bp.y * p_cosR
          );
          vec3 p_c = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z);
          vec4 mvPosition = modelViewMatrix * vec4(p_c, 1.0);
          mvPosition.xy += p_bp;
          gl_Position = projectionMatrix * mvPosition;
          `,
        )
        // Billboard world position — p_c and p_bp in scope from project_vertex above
        .replace(
          "#include <worldpos_vertex>",
          `
          #if defined(USE_SHADOWMAP) || defined(USE_ENVMAP) || defined(DISTANCE) || (NUM_SPOT_LIGHT_COORDS > 0)
            vec3 p_cr = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 p_cu = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            vec4 worldPosition = vec4(
              (modelMatrix * vec4(p_c, 1.0)).xyz + p_cr * p_bp.x + p_cu * p_bp.y,
              1.0
            );
          #endif
          `,
        );

    // --- Fragment shader ---

    const fragmentPreamble = [
      PARTICLE_DEFINES,
      `#define SRGB_SUPPORTED ${srgbSupported}`,
      uniformDeclarations.join("\n"),
      "varying vec2 p_uv;",
      varyingDeclarations.join("\n"),
      srgbHelper,
      renamedSources.join("\n"),
    ].join("\n");

    let fragmentShader = shader.fragmentShader;

    if (normalsMode === FXParticleNormalsMode.Spherical) {
      fragmentShader = fragmentShader.replace(
        "#include <normal_fragment_begin>",
        `
        float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
        vec2 p_sn = p_uv * 2.0 - 1.0;
        vec3 normal = normalize(vec3(p_sn, sqrt(max(0.0, 1.0 - dot(p_sn, p_sn)))));
        `,
      );
    } else if (normalsMode === FXParticleNormalsMode.TowardsLight) {
      fragmentShader = fragmentShader.replace(
        "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );",
        "float dotNL = 1.0;",
      );
    }

    shader.fragmentShader =
      fragmentPreamble +
      "\n" +
      fragmentShader
        // Inject custom diffuse color from draw() pipeline
        .replace(
          "#include <map_fragment>",
          `
          vec4 p_color = ${drawCalls};
          if (p_color.a < 0.0035) discard;
          diffuseColor = p_color;
          `,
        );
  };

  material.customProgramCacheKey = (): string =>
    `fx-particle-lambert-${normalsMode}-${sources.join("|")}`;

  return material;
}
