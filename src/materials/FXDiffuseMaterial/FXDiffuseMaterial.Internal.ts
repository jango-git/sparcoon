import { Color, DoubleSide, MeshLambertMaterial, NormalBlending } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { PARTICLE_DEFINES } from "../../miscellaneous/miscellaneous";
import type { FXNodeBlending } from "../../nodes/blending/FXNodeBlending";
import { FXNodeColor } from "../../nodes/color/FXNodeColor";
import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../../nodes/FXNode";
import type { FXNodeNormal } from "../../nodes/normal/FXNodeNormal";
import { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";
import { buildAlbedoAndBlendingCode } from "../FXMaterial/FXBlending.Internal";
import { FXBlending } from "../FXMaterial/FXMaterial";

export interface FXScatterUniforms {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  u_ScatterTint: { value: Color };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  u_ScatterPower: { value: number };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  u_ForwardScatterStrength: { value: number };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  u_BackScatterStrength: { value: number };
}

/**
 * Wraps every `getShadow(...)` call in the shader source with
 * `mix(1.0, getShadow(...), <uniformName>)` so that a uniform
 * can scale shadow influence from 0 (no shadows) to 1 (full shadows).
 */
function wrapShadowCalls(source: string, uniformName: string): string {
  const target = "getShadow(";
  let result = "";
  let position = 0;

  while (position < source.length) {
    const callStart = source.indexOf(target, position);
    if (callStart === -1) {
      result += source.slice(position);
      break;
    }

    result += source.slice(position, callStart);

    let depth = 0;
    let cursor = callStart + target.length - 1;
    for (; cursor < source.length; cursor++) {
      if (source[cursor] === "(") {
        depth++;
      }
      if (source[cursor] === ")") {
        depth--;
      }
      if (depth === 0) {
        break;
      }
    }

    const originalCall = source.slice(callStart, cursor + 1);
    result += `mix(1.0, ${originalCall}, ${uniformName})`;
    position = cursor + 1;
  }

  return result;
}

export function buildFXDiffuseMaterial(
  varyings: Record<string, GLTypeInfo>,
  blending: FXBlending,
  useAlphaHashing: boolean,
  alphaTest: number,
  albedoNodes: readonly (FXNodeColor | FXNodeTexture | FXNodeBlending)[],
  normalNodes: readonly (FXNodeTexture | FXNodeNormal)[],
  emissionNodes: readonly (FXNodeColor | FXNodeTexture)[],
  scatterUniforms?: FXScatterUniforms,
  shadowSensitivity?: { value: number },
): MeshLambertMaterial {
  const useScatter = scatterUniforms !== undefined;
  const useShadowSensitivity = shadowSensitivity !== undefined;
  const useNormals = normalNodes.length > 0;

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
    name: "FXDiffuseMaterial",
    transparent: !useAlphaHashing,
    depthWrite: useAlphaHashing,
    depthTest: true,
    alphaHash: useAlphaHashing,
    blending: NormalBlending,
    side: DoubleSide,
    forceSinglePass: true,
    alphaTest,
    emissive: emissionNodes.length > 0 ? new Color(1, 1, 1) : new Color(0, 0, 0),
    premultipliedAlpha: true,
  });

  material.onBeforeCompile = (shader): void => {
    const vertexPreamble = [
      PARTICLE_DEFINES,
      attributeDeclarations.join("\n"),
      "varying vec2 p_uv;",
      useNormals ? "varying vec2 p_billboardSinCos;" : "",
      useScatter ? "varying vec3 v_viewPosition;" : "",
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
          [
            "vec2 billboardOffset = position.xy;",
            "billboardOffset.x *= PARTICLE_SCALE_X;",
            "billboardOffset.y *= PARTICLE_SCALE_Y;",
            "",
            "float cosRotation = cos(PARTICLE_ROTATION);",
            "float sinRotation = sin(PARTICLE_ROTATION);",
            "billboardOffset = vec2(",
            "  billboardOffset.x * cosRotation - billboardOffset.y * sinRotation,",
            "  billboardOffset.x * sinRotation + billboardOffset.y * cosRotation",
            ");",
            "",
            // Pass the exact sin/cos that rotated the billboard to the fragment shader.
            useNormals ? "p_billboardSinCos = vec2(sinRotation, cosRotation);" : "",
            "",
            "vec3 particleCenter = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z);",
            "vec4 mvPosition = modelViewMatrix * vec4(particleCenter, 1.0);",
            "mvPosition.xy += billboardOffset;",
            useScatter ? "v_viewPosition = mvPosition.xyz;" : "",
            "gl_Position = projectionMatrix * mvPosition;",
          ].join("\n"),
        )
        .replace(
          "#include <worldpos_vertex>",
          `
          #if defined(USE_SHADOWMAP) || defined(USE_ENVMAP) || defined(DISTANCE) || (NUM_SPOT_LIGHT_COORDS > 0)
            vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 cameraUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            vec4 worldPosition = vec4(
              (modelMatrix * vec4(particleCenter, 1.0)).xyz + cameraRight * billboardOffset.x + cameraUp * billboardOffset.y,
              1.0
            );
          #endif
          `,
        );

    const seenCacheKeys = new Set<string>();
    const uniqueHelpers = (
      nodes: readonly (FXNodeColor | FXNodeTexture | FXNodeNormal | FXNodeBlending)[],
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

    const scatterDeclarations: string[] = useScatter
      ? [
          "varying vec3 v_viewPosition;",
          "uniform vec3 u_ScatterTint;",
          "uniform float u_ScatterPower;",
          "uniform float u_ForwardScatterStrength;",
          "uniform float u_BackScatterStrength;",
          `vec3 calculateScatter(vec3 viewDirection, vec3 lightDirection, vec3 lightColor, float alpha) {
            float viewDotLight = dot(viewDirection, lightDirection);
            float scatterForward  = pow(max(-viewDotLight, 0.0), u_ScatterPower) * u_ForwardScatterStrength;
            float scatterBackward = pow(max( viewDotLight, 0.0), 2.0) * u_BackScatterStrength;
            return lightColor * u_ScatterTint * (scatterForward + scatterBackward) * alpha;
          }`,
        ]
      : [];

    const shadowSensitivityDeclarations: string[] = useShadowSensitivity
      ? ["uniform float u_shadowSensitivity;"]
      : [];

    const fragmentPreamble = [
      PARTICLE_DEFINES,
      "varying vec2 p_uv;",
      useNormals ? "varying vec2 p_billboardSinCos;" : "",
      varyingDeclarations.join("\n"),
      albedoNodes.flatMap((node) => node.uniformDeclarations).join("\n"),
      uniqueHelpers(albedoNodes),
      normalNodes.flatMap((node) => node.uniformDeclarations).join("\n"),
      uniqueHelpers(normalNodes),
      emissionNodes.flatMap((node) => node.uniformDeclarations).join("\n"),
      uniqueHelpers(emissionNodes),
      ...scatterDeclarations,
      ...shadowSensitivityDeclarations,
    ].join("\n");

    if (useScatter) {
      shader.uniforms["u_ScatterTint"] = scatterUniforms.u_ScatterTint;
      shader.uniforms["u_ScatterPower"] = scatterUniforms.u_ScatterPower;
      shader.uniforms["u_ForwardScatterStrength"] = scatterUniforms.u_ForwardScatterStrength;
      shader.uniforms["u_BackScatterStrength"] = scatterUniforms.u_BackScatterStrength;
    }

    if (useShadowSensitivity) {
      shader.uniforms["u_shadowSensitivity"] = shadowSensitivity;
    }

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

    if (useNormals) {
      const normalLines = [
        "float faceDirection = gl_FrontFacing ? 1.0 : -1.0;",
        "vec3 fxNormal = vec3(0.0, 0.0, 1.0);",
      ];

      for (const node of normalNodes) {
        if (node instanceof FXNodeTexture || node instanceof FXNodeColor) {
          normalLines.push(
            `fxNormal = normalize((${node.colorExpression.replace(CURRENT_EXPRESSION_VALUE_PLACEHOLDER, "vec4(fxNormal, 1.0)")}).rgb * 2.0 - 1.0);`,
          );
        } else {
          normalLines.push(
            `fxNormal = ${node.normalExpression.replace(CURRENT_EXPRESSION_VALUE_PLACEHOLDER, "fxNormal")};`,
          );
        }
      }

      normalLines.push(
        "",
        "float sinR = p_billboardSinCos.x;",
        "float cosR = p_billboardSinCos.y;",
        "vec3 normal = vec3(",
        "  fxNormal.x * cosR - fxNormal.y * sinR,",
        "  fxNormal.x * sinR + fxNormal.y * cosR,",
        "  fxNormal.z",
        ");",
        "",
        "normal *= faceDirection;",
      );

      fragmentShader = fragmentShader.replace(
        "#include <normal_fragment_begin>",
        normalLines.join("\n"),
      );
    }

    const albedoCode = buildAlbedoAndBlendingCode(albedoNodes, blending, useAlphaHashing);

    if (albedoCode.mapFragment !== null) {
      fragmentShader = fragmentShader.replace("#include <map_fragment>", albedoCode.mapFragment);
    }

    if (emissionNodes.length > 0) {
      const emissiveLines = ["vec4 fxEmissive = vec4(1.0);"];
      for (const node of emissionNodes) {
        emissiveLines.push(
          `fxEmissive = ${node.colorExpression.replace(CURRENT_EXPRESSION_VALUE_PLACEHOLDER, "fxEmissive")};`,
        );
      }
      emissiveLines.push("totalEmissiveRadiance = fxEmissive.rgb;");
      fragmentShader = fragmentShader.replace(
        "#include <emissivemap_fragment>",
        emissiveLines.join("\n"),
      );
    }

    if (useScatter) {
      fragmentShader = fragmentShader.replace(
        "#include <opaque_fragment>",
        `
        #ifdef OPAQUE
          diffuseColor.a = 1.0;
        #endif

        vec3 viewDirection = normalize(-v_viewPosition);
        vec3 totalScatter = vec3(0.0);

        #if NUM_DIR_LIGHTS > 0
          for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
            totalScatter += calculateScatter(viewDirection, directionalLights[i].direction, directionalLights[i].color, diffuseColor.a);
          }
        #endif

        #if NUM_POINT_LIGHTS > 0
          for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
            vec3 toLightDirection = normalize(pointLights[i].position - v_viewPosition);
            float lightDistance = length(pointLights[i].position - v_viewPosition);
            float attenuation = 1.0 / (1.0 + 0.09 * lightDistance + 0.032 * lightDistance * lightDistance);
            totalScatter += calculateScatter(viewDirection, toLightDirection, pointLights[i].color, diffuseColor.a) * attenuation;
          }
        #endif

        #if NUM_SPOT_LIGHTS > 0
          for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
            vec3 toLightDirection = normalize(spotLights[i].position - v_viewPosition);
            float lightDistance = length(spotLights[i].position - v_viewPosition);
            float attenuation = 1.0 / (1.0 + 0.09 * lightDistance + 0.032 * lightDistance * lightDistance);
            float spotCosine = dot(normalize(spotLights[i].direction), -toLightDirection);
            float spotFalloff = smoothstep(spotLights[i].coneCos, spotLights[i].penumbraCos, spotCosine);
            totalScatter += calculateScatter(viewDirection, toLightDirection, spotLights[i].color, diffuseColor.a) * attenuation * spotFalloff;
          }
        #endif

        vec3 albedo = diffuseColor.a > 0.001
            ? diffuseColor.rgb / diffuseColor.a
            : vec3(0.0);
        gl_FragColor = vec4(outgoingLight + totalScatter * albedo, diffuseColor.a);
        `,
      );
    }

    if (useShadowSensitivity) {
      fragmentShader = wrapShadowCalls(fragmentShader, "u_shadowSensitivity");
    }

    fragmentShader = fragmentShader.replace(
      "#include <premultiplied_alpha_fragment>",
      albedoCode.premultChunk,
    );

    shader.fragmentShader = fragmentPreamble + "\n" + fragmentShader;
  };

  const scatterKey = useScatter ? `scatter(${scatterUniforms.u_ScatterPower.value})` : "no-scatter";
  const shadowKey = useShadowSensitivity ? "shadow-sens" : "no-shadow-sens";

  material.customProgramCacheKey = (): string =>
    [
      "fx",
      albedoNodes.map((node) => node.cacheKey).join("-") || "none",
      normalNodes.map((node) => node.cacheKey).join("-") || "none",
      emissionNodes.map((node) => node.cacheKey).join("-") || "none",
      FXBlending[blending],
      scatterKey,
      shadowKey,
    ].join("_");

  return material;
}
