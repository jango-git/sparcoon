import type { Blending } from "three";
import { DoubleSide, MeshBasicMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { PARTICLE_DEFINES } from "../../miscellaneous/miscellaneous";
import type { FXColorNode } from "../../nodes/color/FXColorNode";
import type { FXTextureNode } from "../../nodes/texture/FXTextureNode";

export function buildFXUnlitMaterial(
  varyings: Record<string, GLTypeInfo>,
  blending: Blending,
  useAlphaHashing: boolean,
  alphaTest: number,
  premultipliedAlpha: boolean,
  albedoNodes: readonly (FXColorNode | FXTextureNode)[],
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
    name: "FXUnlitMaterial",
    transparent: !useAlphaHashing,
    depthWrite: useAlphaHashing,
    depthTest: true,
    alphaHash: useAlphaHashing,
    blending,
    side: DoubleSide,
    forceSinglePass: true,
    alphaTest,
    premultipliedAlpha,
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
          // Scale and rotate the billboard offset in camera space
          vec2 billboardOffset = position.xy;
          billboardOffset.x *= PARTICLE_SCALE_X;
          billboardOffset.y *= PARTICLE_SCALE_Y;

          float cosRotation = cos(PARTICLE_ROTATION);
          float sinRotation = sin(PARTICLE_ROTATION);
          billboardOffset = vec2(
            billboardOffset.x * cosRotation - billboardOffset.y * sinRotation,
            billboardOffset.x * sinRotation + billboardOffset.y * cosRotation
          );

          // Move particle center to view space, then apply the billboard offset
          vec3 particleCenter = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z);
          vec4 mvPosition = modelViewMatrix * vec4(particleCenter, 1.0);
          mvPosition.xy += billboardOffset;
          gl_Position = projectionMatrix * mvPosition;
          `,
        );

    const seenCacheKeys = new Set<string>();
    const uniqueHelpers = (nodes: readonly (FXColorNode | FXTextureNode)[]): string =>
      nodes
        .filter((n) => {
          if (seenCacheKeys.has(n.cacheKey)) {
            return false;
          }
          seenCacheKeys.add(n.cacheKey);
          return true;
        })
        .map((n) => n.helperFunctions)
        .join("\n");

    const fragmentPreamble = [
      PARTICLE_DEFINES,
      "varying vec2 p_uv;",
      varyingDeclarations.join("\n"),
      albedoNodes.flatMap((n) => n.uniformDeclarations).join("\n"),
      uniqueHelpers(albedoNodes),
    ].join("\n");

    for (const node of albedoNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }

    let fragmentShader = shader.fragmentShader;

    if (albedoNodes.length > 0) {
      const combinedExpression = albedoNodes.map((n) => n.colorExpression).join(" * ");
      const discardLine = useAlphaHashing ? "" : "if (diffuseColor.a < 0.0035) discard;";
      fragmentShader = fragmentShader.replace(
        "#include <map_fragment>",
        `diffuseColor = ${combinedExpression}; ${discardLine}`,
      );
    }

    shader.fragmentShader = fragmentPreamble + "\n" + fragmentShader;
  };

  material.customProgramCacheKey = (): string =>
    `fx-unlit-${albedoNodes.map((n) => n.cacheKey).join("-") || "none"}`;

  return material;
}
