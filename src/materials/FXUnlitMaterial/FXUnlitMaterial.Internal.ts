import { DoubleSide, MeshBasicMaterial, type Blending } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import type { FXColorNode } from "../color-nodes/FXColorNode";
import { PARTICLE_DEFINES } from "../miscellaneous";

export function buildFXUnlitMaterial(
  varyings: Record<string, GLTypeInfo>,
  blending: Blending,
  useAlphaHashing: boolean,
  colorNodes: readonly FXColorNode[],
): MeshBasicMaterial {
  const attributeDeclarations: string[] = [];
  const varyingDeclarations: string[] = [];
  const vertexAssignments: string[] = [];

  for (const name in varyings) {
    const { glslTypeName } = varyings[name];
    attributeDeclarations.push(`attribute ${glslTypeName} a_${name};`);
    varyingDeclarations.push(`varying ${glslTypeName} p_${name};`);
    vertexAssignments.push(`p_${name} = a_${name};`);
  }

  const material = new MeshBasicMaterial({
    transparent: !useAlphaHashing,
    depthWrite: useAlphaHashing,
    depthTest: true,
    alphaHash: useAlphaHashing,
    blending,
    side: DoubleSide,
    forceSinglePass: true,
    alphaTest: 1 / 255,
  });

  material.onBeforeCompile = (shader): void => {
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
        .replace(
          "#include <begin_vertex>",
          [
            "p_uv = uv;",
            vertexAssignments.join("\n"),
            "vec3 transformed = position;",
            "#ifdef USE_ALPHAHASH",
            "  vPosition = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z) + vec3(position.xy, 0.0);",
            "#endif",
          ].join("\n"),
        )
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
        );

    const fragmentPreamble = [
      PARTICLE_DEFINES,
      "varying vec2 p_uv;",
      varyingDeclarations.join("\n"),
      colorNodes.flatMap((n) => n.uniformDeclarations).join("\n"),
      colorNodes.map((n) => n.helperFunctions).join("\n"),
    ].join("\n");

    for (const node of colorNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }

    let fragmentShader = shader.fragmentShader;

    if (colorNodes.length > 0) {
      const combinedExpression = colorNodes.map((n) => n.colorExpression).join(" * ");
      const discardLine = useAlphaHashing ? "" : "if (diffuseColor.a < 0.0035) discard;";
      fragmentShader = fragmentShader.replace(
        "#include <map_fragment>",
        `diffuseColor = ${combinedExpression}; ${discardLine}`,
      );
    }

    shader.fragmentShader = fragmentPreamble + "\n" + fragmentShader;
  };

  material.customProgramCacheKey = (): string =>
    `fx-unlit-${colorNodes.map((n) => n.cacheKey).join("-") || "none"}`;

  return material;
}
