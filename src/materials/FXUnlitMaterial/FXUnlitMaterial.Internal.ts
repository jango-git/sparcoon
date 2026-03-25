import { DoubleSide, MeshBasicMaterial, NormalBlending } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { PARTICLE_DEFINES } from "../../miscellaneous/miscellaneous";
import type { FXNodeBlending } from "../../nodes/blending/FXNodeBlending";
import type { FXNodeColor } from "../../nodes/color/FXNodeColor";
import type { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";
import { buildAlbedoAndBlendingCode } from "../FXMaterial/FXBlending.Internal";
import { FXBlending } from "../FXMaterial/FXMaterial";

export function buildFXUnlitMaterial(
  varyings: Record<string, GLTypeInfo>,
  blending: FXBlending,
  useAlphaHashing: boolean,
  alphaTest: number,
  albedoNodes: readonly (FXNodeColor | FXNodeTexture | FXNodeBlending)[],
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
    blending: NormalBlending,
    side: DoubleSide,
    forceSinglePass: true,
    alphaTest,
    premultipliedAlpha: true,
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
    const uniqueHelpers = (
      nodes: readonly (FXNodeColor | FXNodeTexture | FXNodeBlending)[],
    ): string =>
      nodes
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
      "varying vec2 p_uv;",
      varyingDeclarations.join("\n"),
      albedoNodes.flatMap((node) => node.uniformDeclarations).join("\n"),
      uniqueHelpers(albedoNodes),
    ].join("\n");

    for (const node of albedoNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }

    const albedoCode = buildAlbedoAndBlendingCode(albedoNodes, blending, useAlphaHashing);

    let fragmentShader = shader.fragmentShader;

    if (albedoCode.mapFragment !== null) {
      fragmentShader = fragmentShader.replace("#include <map_fragment>", albedoCode.mapFragment);
    }

    fragmentShader = fragmentShader.replace(
      "#include <premultiplied_alpha_fragment>",
      albedoCode.premultChunk,
    );

    shader.fragmentShader = fragmentPreamble + "\n" + fragmentShader;
  };

  material.customProgramCacheKey = (): string =>
    ["fx-unlit", albedoNodes.map((node) => node.cacheKey).join("-") || "none", FXBlending[blending]].join(
      "_",
    );

  return material;
}
