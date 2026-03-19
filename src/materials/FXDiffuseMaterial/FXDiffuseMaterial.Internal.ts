import type { Blending } from "three";
import { Color, DoubleSide, MeshLambertMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { PARTICLE_DEFINES } from "../../miscellaneous/miscellaneous";
import type { FXColorNode } from "../../nodes/color/FXColorNode";
import type { FXNormalNode } from "../../nodes/normal/FXNormalNode";
import { FXTextureNode } from "../../nodes/texture/FXTextureNode";

export function buildFXDiffuseMaterial(
  varyings: Record<string, GLTypeInfo>,
  blending: Blending,
  useAlphaHashing: boolean,
  alphaTest: number,
  albedoNodes: readonly (FXColorNode | FXTextureNode)[],
  normalNodes: readonly (FXTextureNode | FXNormalNode)[],
  emissionNodes: readonly (FXColorNode | FXTextureNode)[],
): MeshLambertMaterial {
  const attributeDeclarations: string[] = [];
  const varyingDeclarations: string[] = [];
  const vertexAssignments: string[] = [];

  for (const name in varyings) {
    const { glslTypeName } = varyings[name];
    attributeDeclarations.push(`attribute ${glslTypeName} a_${name};`);
    varyingDeclarations.push(`varying ${glslTypeName} p_${name};`);
    vertexAssignments.push(`p_${name} = a_${name};`);
  }

  const material = new MeshLambertMaterial({
    transparent: !useAlphaHashing,
    depthWrite: useAlphaHashing,
    depthTest: true,
    alphaHash: useAlphaHashing,
    blending,
    side: DoubleSide,
    forceSinglePass: true,
    alphaTest,
    emissive: emissionNodes.length > 0 ? new Color(1, 1, 1) : new Color(0, 0, 0),
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
        .replace("#include <beginnormal_vertex>", "vec3 objectNormal = vec3(0.0, 0.0, 1.0);")
        .replace("#include <defaultnormal_vertex>", "vec3 transformedNormal = vec3(0.0, 0.0, 1.0);")
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
        )
        .replace(
          "#include <worldpos_vertex>",
          `
          #if defined(USE_SHADOWMAP) || defined(USE_ENVMAP) || defined(DISTANCE) || (NUM_SPOT_LIGHT_COORDS > 0)
            // Reconstruct world-space position for shadow/environment maps.
            // Camera right and up are the first two rows of the view matrix rotation (transposed).
            vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 cameraUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            vec4 worldPosition = vec4(
              (modelMatrix * vec4(particleCenter, 1.0)).xyz + cameraRight * billboardOffset.x + cameraUp * billboardOffset.y,
              1.0
            );
          #endif
          `,
        );

    const blendReorientedNormalsHelper: string =
      normalNodes.length > 1
        ? `
          vec3 blendReorientedNormals(vec3 base, vec3 detail) {
            base += vec3(0.0, 0.0, 1.0);
            detail *= vec3(-1.0, -1.0, 1.0);
            return normalize(base * dot(base, detail) / base.z - detail);
          }
        `
        : "";

    const seenCacheKeys = new Set<string>();
    const uniqueHelpers = (
      nodes: readonly (FXColorNode | FXTextureNode | FXNormalNode)[],
    ): string =>
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
      normalNodes.flatMap((n) => n.uniformDeclarations).join("\n"),
      uniqueHelpers(normalNodes),
      blendReorientedNormalsHelper,
      emissionNodes.flatMap((n) => n.uniformDeclarations).join("\n"),
      uniqueHelpers(emissionNodes),
    ].join("\n");

    for (const node of albedoNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }
    for (const node of normalNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }
    for (const node of emissionNodes) {
      Object.assign(shader.uniforms, node.uniforms);
    }

    let fragmentShader = shader.fragmentShader;

    if (normalNodes.length > 0) {
      const normalExpressions = normalNodes.map((node) => {
        if (node instanceof FXTextureNode) {
          return `normalize(${node.colorExpression}.rgb * 2.0 - 1.0)`;
        }
        return node.normalExpression;
      });

      const blendLines = normalExpressions
        .slice(1)
        .map((expression) => `normal = blendReorientedNormals(normal, ${expression});`);

      const normalCode = [
        "float faceDirection = gl_FrontFacing ? 1.0 : -1.0;",
        `vec3 normal = ${normalExpressions[0]};`,
        ...blendLines,
      ].join("\n");

      fragmentShader = fragmentShader.replace("#include <normal_fragment_begin>", normalCode);
    }

    if (albedoNodes.length > 0) {
      const combinedExpression = albedoNodes.map((n) => n.colorExpression).join(" * ");
      const discardLine = useAlphaHashing ? "" : "if (diffuseColor.a < 0.0035) discard;";
      fragmentShader = fragmentShader.replace(
        "#include <map_fragment>",
        `diffuseColor = ${combinedExpression}; ${discardLine}`,
      );
    }

    if (emissionNodes.length > 0) {
      const combinedExpression = emissionNodes.map((n) => n.colorExpression).join(" * ");
      fragmentShader = fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `totalEmissiveRadiance = (${combinedExpression}).rgb;`,
      );
    }

    shader.fragmentShader = fragmentPreamble + "\n" + fragmentShader;
  };

  material.customProgramCacheKey = (): string =>
    `fx-diffuse-${albedoNodes.map((n) => n.cacheKey).join("-") || "none"}-${normalNodes.map((n) => n.cacheKey).join("-") || "none"}-${emissionNodes.map((n) => n.cacheKey).join("-") || "none"}`;

  return material;
}
