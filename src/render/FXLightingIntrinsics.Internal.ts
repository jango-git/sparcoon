import type { FXRenderArtifact } from "../artifact/FXArtifact.js";

/**
 * The lighting intrinsics - part of the `fx` cross-repo ABI, like Depth Fade: a lighting node emits
 * a call by name, the artifact lists the names it calls ({@link FXRenderArtifact.lightingIntrinsics}),
 * and the runtime defines exactly those. The editor takes the names from here.
 */
export const FX_LIGHTING_INTRINSIC = {
  /** `(vec4 color, vec3 worldNormal)`: diffuse Lambert, direct + indirect + shadows. */
  lambert: "fxLambertShade",
  /** `(vec4 color, vec3 worldNormal)`: indirect only - ambient, light probe, hemisphere. */
  ambient: "fxAmbientShade",
  /** `(vec4 color, vec3 worldNormal, float wrap, float scatter, float focus)`: wrapped Lambert plus
   *  forward scattering toward the camera, direct + indirect + shadows. */
  halfLit: "fxHalfLitShade",
} as const;

/** A name of {@link FX_LIGHTING_INTRINSIC}. */
export type FXLightingIntrinsicName =
  (typeof FX_LIGHTING_INTRINSIC)[keyof typeof FX_LIGHTING_INTRINSIC];

interface FXLightingIntrinsic {
  /** The color stage's definition: top-level GLSL, after three's light pars chunks. */
  readonly definition: string;
  /** The depth stages' twin: the same signature, the input color back unshaded - depth reads only
   *  its alpha, which every intrinsic passes through. */
  readonly stub: string;
}

/** Every intrinsic's first two parameters. */
const SHADE_PARAMETERS = ["vec4 diffuseColor", "vec3 worldNormal"];

// The graph authors normals in world space; three's light chain runs in view space, so each
// intrinsic converts on its first line and view space stays private to this ABI. The locals are the
// ones the light chunks expect (`normal`, `material`, `reflectedLight`).
const SHADE_PRELUDE = [
  "  vec3 normal = normalize( mat3( viewMatrix ) * worldNormal );",
  "  float specularStrength = 1.0;",
  "  ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );",
  "  #include <lights_lambert_fragment>",
];

/** An intrinsic's GLSL: its function, after any top-level helpers it calls. */
interface FXShadeSource {
  readonly name: FXLightingIntrinsicName;
  /** Parameters after the color and the normal. */
  readonly extraParameters?: readonly string[];
  /** Top-level functions the body calls, defined before it. */
  readonly helpers?: readonly string[];
  /** The body after {@link SHADE_PRELUDE}, ending in its `return`. */
  readonly body: readonly string[];
}

function shadeFunction(source: FXShadeSource): FXLightingIntrinsic {
  const parameters = [...SHADE_PARAMETERS, ...(source.extraParameters ?? [])];
  const signature = `vec4 ${source.name}(${parameters.join(", ")})`;
  return {
    definition: [
      ...(source.helpers ?? []),
      `${signature} {`,
      ...SHADE_PRELUDE,
      ...source.body,
      "}",
    ].join("\n"),
    stub: `${signature} { return diffuseColor; }`,
  };
}

/** How a direct + indirect intrinsic replaces three's per-light term for its own loop. */
interface FXDirectTerm {
  /** The top-level function of the per-light term. */
  readonly helper: string;
  /** Statements before the loop: the locals {@link reDirect} reads. */
  readonly setup: readonly string[];
  /** `RE_Direct`'s replacement: a function-like macro over the stock loop's seven arguments. */
  readonly reDirect: string;
}

/**
 * An intrinsic that runs three's stock per-light loop (point, spot, directional; shadows folded
 * into each light's color) and the indirect term - with three's Lambert term, or `term` swapped in
 * for this loop only and Lambert's restored for whatever follows. `#pragma unroll_loop_start`
 * inside a function is expanded by the renderer's shader-wide unroll pass, so the loops resolve
 * here too.
 */
function directShadeFunction(
  name: FXLightingIntrinsicName,
  extraParameters: readonly string[] = [],
  term?: FXDirectTerm,
): FXLightingIntrinsic {
  const loop =
    term === undefined
      ? ["  #include <lights_fragment_begin>"]
      : [
          ...term.setup,
          "  #undef RE_Direct",
          `  #define RE_Direct${term.reDirect}`,
          "  #include <lights_fragment_begin>",
          "  #undef RE_Direct",
          "  #define RE_Direct RE_Direct_Lambert",
        ];
  return shadeFunction({
    name,
    extraParameters,
    helpers: term === undefined ? [] : [term.helper],
    body: [
      ...loop,
      "  #include <lights_fragment_end>",
      "  return vec4( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, diffuseColor.a );",
    ],
  });
}

const LAMBERT = directShadeFunction(FX_LIGHTING_INTRINSIC.lambert);

// Indirect-only diffuse: the indirect block of `lights_fragment_begin`, no direct-light loop or
// shadows.
const AMBIENT = shadeFunction({
  name: FX_LIGHTING_INTRINSIC.ambient,
  body: [
    "  vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );",
    "  #if defined( USE_LIGHT_PROBES )",
    "    irradiance += getLightProbeIrradiance( lightProbe, normal );",
    "  #endif",
    "  #if ( NUM_HEMI_LIGHTS > 0 )",
    "    #pragma unroll_loop_start",
    "    for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {",
    "      irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], normal );",
    "    }",
    "    #pragma unroll_loop_end",
    "  #endif",
    "  RE_IndirectDiffuse( irradiance, vec3( 0.0 ), normal, vec3( 0.0 ), vec3( 0.0 ), material, reflectedLight );",
    "  return vec4( reflectedLight.indirectDiffuse, diffuseColor.a );",
  ],
});

// Half-Lit's per-light term: wrapped Lambert ((N.L + wrap) / (1 + wrap); 0 = Lambert, 1 = linear
// half-Lambert) plus forward scattering - light passing through toward a camera that looks at the
// light, (V . -L)^focus, scaled by scatter. In the same units as Lambert (BRDF_Lambert, the light's
// color with its shadow already folded in), so the two match on the lit side and mix freely.
// `settings` is (wrap, scatter, focus), already clamped.
const HALF_LIT = directShadeFunction(
  FX_LIGHTING_INTRINSIC.halfLit,
  ["float wrap", "float scatter", "float focus"],
  {
    helper: [
      "void fxHalfLitDirect( const in IncidentLight directLight, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in LambertMaterial material, const in vec3 settings, inout ReflectedLight reflectedLight ) {",
      "  float wrapped = saturate( ( dot( geometryNormal, directLight.direction ) + settings.x ) / ( 1.0 + settings.x ) );",
      "  float forward = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), settings.z );",
      "  reflectedLight.directDiffuse += ( wrapped + settings.y * forward ) * directLight.color * BRDF_Lambert( material.diffuseColor );",
      "}",
    ].join("\n"),
    // The inputs are graph-driven: clamped so a divide by (1 + wrap) and pow(0, focus) stay defined.
    setup: [
      "  vec3 fxHalfLitSettings = vec3( clamp( wrap, 0.0, 1.0 ), max( scatter, 0.0 ), max( focus, 1.0 ) );",
    ],
    reDirect:
      "( light, position, normal, viewDir, clearcoatNormal, material, reflected ) fxHalfLitDirect( light, normal, viewDir, material, fxHalfLitSettings, reflected )",
  },
);

// In a fixed order, so a shader's text does not depend on the order the artifact lists them in.
const INTRINSICS: ReadonlyMap<string, FXLightingIntrinsic> = new Map<
  FXLightingIntrinsicName,
  FXLightingIntrinsic
>([
  [FX_LIGHTING_INTRINSIC.lambert, LAMBERT],
  [FX_LIGHTING_INTRINSIC.ambient, AMBIENT],
  [FX_LIGHTING_INTRINSIC.halfLit, HALF_LIT],
]);

/** The intrinsics `render` lists; throws on a name this runtime does not define. */
function listedIntrinsics(render: FXRenderArtifact): FXLightingIntrinsic[] {
  for (const name of render.lightingIntrinsics) {
    if (!INTRINSICS.has(name)) {
      throw new Error(
        `unknown lighting intrinsic "${name}": this runtime does not define it - ` +
          "re-export the effect from a matching editor",
      );
    }
  }
  return [...INTRINSICS]
    .filter(([name]) => render.lightingIntrinsics.includes(name))
    .map(([, intrinsic]) => intrinsic);
}

/** Whether `render` shades with scene lights - and so needs the lit material variant. */
export function isLitArtifact(render: FXRenderArtifact): boolean {
  return render.lightingIntrinsics.length > 0;
}

/** The color stage's definitions of exactly the intrinsics `render` calls; placed after three's
 *  light pars chunks, before `main`. */
export function lightingFunctions(render: FXRenderArtifact): string {
  return listedIntrinsics(render)
    .map((intrinsic) => intrinsic.definition)
    .join("\n");
}

/** {@link lightingFunctions} for a depth (shadow-caster) material: the shade-free stubs. */
export function lightingStubs(render: FXRenderArtifact): string {
  return listedIntrinsics(render)
    .map((intrinsic) => intrinsic.stub)
    .join("\n");
}
