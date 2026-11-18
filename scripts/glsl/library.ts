import {
  FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM,
  FX_TRANSFORM_FEEDBACK_VIEW_PROJECTION_UNIFORM,
} from "../../src/behaviorTransformFeedbackLayout.js";
import { FX_NO_SURFACE_DISTANCE } from "../../src/helpers/surface.js";
import { everyTier, type FXGLSLHelperDefinition } from "./helperDefinition.js";
import { STANDARD_HASH } from "./noiseHash.js";

/** The helpers of the compiler's functions and render nodes that no noise family generates. */

/** `fxTranspose`, `fxDeterminant`, `fxInverse` of mat2/mat3/mat4: GLSL ES 1.00 has none. */
const MATRIX_HELPERS: readonly FXGLSLHelperDefinition[] = [
  {
    name: "FX_GLSL_TRANSPOSE",
    source: `
mat2 fxTranspose(mat2 m){return mat2(m[0][0],m[1][0],m[0][1],m[1][1]);}
mat3 fxTranspose(mat3 m){return mat3(m[0][0],m[1][0],m[2][0],m[0][1],m[1][1],m[2][1],m[0][2],m[1][2],m[2][2]);}
mat4 fxTranspose(mat4 m){return mat4(
  m[0][0],m[1][0],m[2][0],m[3][0],
  m[0][1],m[1][1],m[2][1],m[3][1],
  m[0][2],m[1][2],m[2][2],m[3][2],
  m[0][3],m[1][3],m[2][3],m[3][3]);}`,
    requires: everyTier(),
  },
  {
    name: "FX_GLSL_DETERMINANT",
    source: `
float fxDeterminant(mat2 m){return m[0][0]*m[1][1]-m[0][1]*m[1][0];}
float fxDeterminant(mat3 m){
  return m[0][0]*(m[1][1]*m[2][2]-m[2][1]*m[1][2])
        -m[1][0]*(m[0][1]*m[2][2]-m[2][1]*m[0][2])
        +m[2][0]*(m[0][1]*m[1][2]-m[1][1]*m[0][2]);}
float fxDeterminant(mat4 m){
  float b00=m[0][0]*m[1][1]-m[0][1]*m[1][0];
  float b01=m[0][0]*m[1][2]-m[0][2]*m[1][0];
  float b02=m[0][0]*m[1][3]-m[0][3]*m[1][0];
  float b03=m[0][1]*m[1][2]-m[0][2]*m[1][1];
  float b04=m[0][1]*m[1][3]-m[0][3]*m[1][1];
  float b05=m[0][2]*m[1][3]-m[0][3]*m[1][2];
  float b06=m[2][0]*m[3][1]-m[2][1]*m[3][0];
  float b07=m[2][0]*m[3][2]-m[2][2]*m[3][0];
  float b08=m[2][0]*m[3][3]-m[2][3]*m[3][0];
  float b09=m[2][1]*m[3][2]-m[2][2]*m[3][1];
  float b10=m[2][1]*m[3][3]-m[2][3]*m[3][1];
  float b11=m[2][2]*m[3][3]-m[2][3]*m[3][2];
  return b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;}`,
    requires: everyTier(),
  },
  {
    name: "FX_GLSL_INVERSE",
    source: `
mat2 fxInverse(mat2 m){
  return mat2(m[1][1],-m[0][1],-m[1][0],m[0][0])/(m[0][0]*m[1][1]-m[0][1]*m[1][0]);}
mat3 fxInverse(mat3 m){
  float a00=m[0][0],a01=m[0][1],a02=m[0][2];
  float a10=m[1][0],a11=m[1][1],a12=m[1][2];
  float a20=m[2][0],a21=m[2][1],a22=m[2][2];
  float b01=a22*a11-a12*a21;
  float b11=-a22*a10+a12*a20;
  float b21=a21*a10-a11*a20;
  float det=a00*b01+a01*b11+a02*b21;
  return mat3(b01,(-a22*a01+a02*a21),(a12*a01-a02*a11),
              b11,(a22*a00-a02*a20),(-a12*a00+a02*a10),
              b21,(-a21*a00+a01*a20),(a11*a00-a01*a10))/det;}
mat4 fxInverse(mat4 m){
  float a00=m[0][0],a01=m[0][1],a02=m[0][2],a03=m[0][3];
  float a10=m[1][0],a11=m[1][1],a12=m[1][2],a13=m[1][3];
  float a20=m[2][0],a21=m[2][1],a22=m[2][2],a23=m[2][3];
  float a30=m[3][0],a31=m[3][1],a32=m[3][2],a33=m[3][3];
  float b00=a00*a11-a01*a10;
  float b01=a00*a12-a02*a10;
  float b02=a00*a13-a03*a10;
  float b03=a01*a12-a02*a11;
  float b04=a01*a13-a03*a11;
  float b05=a02*a13-a03*a12;
  float b06=a20*a31-a21*a30;
  float b07=a20*a32-a22*a30;
  float b08=a20*a33-a23*a30;
  float b09=a21*a32-a22*a31;
  float b10=a21*a33-a23*a31;
  float b11=a22*a33-a23*a32;
  float det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  return mat4(
    a11*b11-a12*b10+a13*b09, a02*b10-a01*b11-a03*b09, a31*b05-a32*b04+a33*b03, a22*b04-a21*b05-a23*b03,
    a12*b08-a10*b11-a13*b07, a00*b11-a02*b08+a03*b07, a32*b02-a30*b05-a33*b01, a20*b05-a22*b02+a23*b01,
    a10*b10-a11*b08+a13*b06, a01*b08-a00*b10-a03*b06, a30*b04-a31*b02+a33*b00, a21*b02-a20*b04-a23*b00,
    a11*b07-a10*b09-a12*b06, a00*b09-a01*b07+a02*b06, a31*b01-a30*b03-a32*b00, a20*b03-a21*b01+a22*b00)/det;}`,
    requires: everyTier(),
  },
];

/**
 * The GPU simulation's `rand()`: hashes (vertex id, per-tick seed, call counter). `fxRandCounter` is
 * a per-invocation global, so it only decorrelates the several `rand()` calls within one
 * invocation; `gl_VertexID` and the seed uniform (changed every tick) decorrelate particles and
 * ticks.
 */
const RAND: FXGLSLHelperDefinition = {
  name: "FX_GLSL_RAND",
  source: `
int fxRandCounter = 0;
float fxNextRandom(){
  fxRandCounter+=1;
  return fxUnit(fxPcg(fxLattice(uvec3(uint(gl_VertexID),uint(${FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM}),uint(fxRandCounter)))));
}`,
  requires: { standard: [STANDARD_HASH] },
};

/** One texel of a mesh surface table (`src/surfaceTableLayout.ts`), by its index. */
const MESH_FETCH: FXGLSLHelperDefinition = {
  name: "FX_GLSL_MESH_FETCH",
  source: `vec4 fxMeshFetch(sampler2D table, float texel) {
  int index = int(texel);
  int width = textureSize(table, 0).x;
  return texelFetch(table, ivec2(index % width, index / width), 0);
}`,
  requires: { standard: [] },
};

/** `sceneDepthContact` where there is no surface: an up normal and {@link FX_NO_SURFACE_DISTANCE}. */
const NO_SURFACE_CONTACT = [0, 1, 0, FX_NO_SURFACE_DISTANCE] as const;

/**
 * The surface of the scene depth at a world-space point, as `vec4(normal, distance)`. The point is
 * projected onto the depth texture with the view-projection the depth was drawn with, and the depth
 * around it is unprojected back to world points with the inverse. The normal crosses the shorter of
 * the two one-sided differences on each axis, so it does not bend across the edge of a silhouette,
 * and faces the camera. There is no surface without depth, off screen, behind the camera, on the far
 * plane (nothing drawn), or deeper than `thickness` behind the surface (the point is behind an
 * occluder, not in it).
 */
const SCENE_DEPTH_CONTACT: FXGLSLHelperDefinition = {
  name: "FX_GLSL_SCENE_DEPTH_CONTACT",
  source: `vec3 fxSceneDepthPoint(vec2 uv) {
  vec4 point = ${FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM} * vec4(vec3(uv, texture(${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM}, uv).r) * 2.0 - 1.0, 1.0);
  return point.xyz / point.w;
}
vec4 fxSceneDepthContact(vec3 position, float thickness) {
  vec4 none = vec4(${NO_SURFACE_CONTACT.map((value) => value.toFixed(1)).join(", ")});
  if (${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM}.z == 0.0) {
    return none;
  }
  vec4 clip = ${FX_TRANSFORM_FEEDBACK_VIEW_PROJECTION_UNIFORM} * vec4(position, 1.0);
  if (clip.w <= 0.0 || any(greaterThan(abs(clip.xy), vec2(clip.w)))) {
    return none;
  }
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  if (texture(${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM}, uv).r >= 1.0) {
    return none;
  }
  vec2 texel = ${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM}.xy;
  vec3 center = fxSceneDepthPoint(uv);
  vec3 right = fxSceneDepthPoint(uv + vec2(texel.x, 0.0)) - center;
  vec3 left = center - fxSceneDepthPoint(uv - vec2(texel.x, 0.0));
  vec3 up = fxSceneDepthPoint(uv + vec2(0.0, texel.y)) - center;
  vec3 down = center - fxSceneDepthPoint(uv - vec2(0.0, texel.y));
  vec3 normal = cross(dot(right, right) < dot(left, left) ? right : left, dot(up, up) < dot(down, down) ? up : down);
  float area = length(normal);
  if (area == 0.0) {
    return none;
  }
  vec4 near = ${FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM} * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  normal /= dot(normal, near.xyz / near.w - center) < 0.0 ? -area : area;
  float distance = dot(position - center, normal);
  return distance < -thickness ? none : vec4(normal, distance);
}`,
  requires: { standard: [] },
};

/** The helpers of the render nodes: the same text on both tiers. */
const NODE_HELPERS: readonly FXGLSLHelperDefinition[] = [
  {
    /** Blend node, normal mode: `blend` over `base`, both with straight alpha. */
    name: "FX_GLSL_BLEND_NORMAL",
    source: `vec4 fxBlendNormal(vec4 base, vec4 blend) {
  float a = blend.a + base.a * (1.0 - blend.a);
  vec3 rgb = (blend.rgb * blend.a + base.rgb * base.a * (1.0 - blend.a)) / max(a, 1e-4);
  return vec4(rgb, a);
}`,
    requires: everyTier(),
  },
  {
    /** Spherical Clip node: alpha faded by the distance from the UV centre. */
    name: "FX_GLSL_SPHERICAL_CLIP",
    source: `vec4 fxApplySphericalClip(vec2 uv, float innerRadius) {
  float distanceToCenter = distance(uv, vec2(0.5, 0.5));
  return vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(innerRadius, 0.5, distanceToCenter));
}`,
    requires: everyTier(),
  },
  {
    /**
     * Dissolve node: max(edge1, edge0 + 1e-4) keeps the span non-zero when edge0 == edge1, so equal
     * edges are a hard threshold rather than undefined GLSL.
     */
    name: "FX_GLSL_LIGHTNESS_BLENDING_MASK",
    source: `float fxLightnessBlendingMask(vec4 color, float edge0, float edge1) {
  float brightness = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  return smoothstep(edge0, max(edge1, edge0 + 1e-4), brightness);
}`,
    requires: everyTier(),
  },
  {
    /**
     * The tangent to world transform of every normal node. Gram-Schmidt re-orthogonalizes T
     * against N; the roll is already in n and t.
     */
    name: "FX_GLSL_TANGENT_TO_WORLD_NORMAL",
    source: `vec3 fxTangentToWorldNormal(vec3 tangentNormal, vec3 n, vec3 t) {
  vec3 N = normalize(n);
  vec3 T = normalize(t - N * dot(N, t));
  vec3 B = cross(N, T);
  return normalize(mat3(T, B, N) * tangentNormal);
}`,
    requires: everyTier(),
  },
  {
    /** Spherical Normal node: a rounded tangent-space normal from the billboard UV. */
    name: "FX_GLSL_SPHERICAL_NORMAL",
    source: `vec3 fxComputeSphericalNormal(vec2 uv) {
  vec2 centeredUV = uv * 2.0 - 1.0;
  return normalize(vec3(centeredUV, sqrt(max(0.0, 1.0 - dot(centeredUV, centeredUV)))));
}`,
    requires: everyTier(),
  },
  {
    /**
     * Normal Map node: [0, 1] rgb to a [-1, 1] tangent normal; `strength` scales only the xy tilt,
     * so 0 is flat.
     */
    name: "FX_GLSL_UNPACK_NORMAL",
    source: `vec3 fxUnpackNormal(vec4 c, float strength) {
  vec3 n = c.rgb * 2.0 - 1.0;
  n.xy *= strength;
  return n;
}`,
    requires: everyTier(),
  },
  {
    /**
     * Flipbook, played once: the cell the playhead sits on, the cell after it, and how far between.
     */
    name: "FX_GLSL_FLIPBOOK_FRAME_ONCE",
    source: `vec3 fxAnimatedFrameOnce(float ratio, float totalFrames) {
  float framePos = clamp(ratio, 0.0, 1.0) * totalFrames;
  float last = totalFrames - 1.0;
  float frame = min(floor(framePos), last);
  return vec3(frame, min(frame + 1.0, last), framePos - frame);
}`,
    requires: everyTier(),
  },
  {
    /** Flipbook, looped: as FX_GLSL_FLIPBOOK_FRAME_ONCE, wrapping to the first cell. */
    name: "FX_GLSL_FLIPBOOK_FRAME_LOOP",
    source: `vec3 fxAnimatedFrameLoop(float ratio, float totalFrames) {
  float framePos = fract(ratio) * totalFrames;
  float frame = floor(framePos);
  return vec3(frame, mod(frame + 1.0, totalFrames), framePos - frame);
}`,
    requires: everyTier(),
  },
  {
    /**
     * The UV of cell `frame` (a whole number) of a `columns` x `rows` sheet, cells left to right,
     * top to bottom. The column is taken off the row rather than by `mod`: `mod(8.0, 8.0)` may come
     * out 7.99..., which would read the cell's right neighbour.
     */
    name: "FX_GLSL_FLIPBOOK_FRAME_UV",
    source: `vec2 fxFlipbookFrameUV(vec2 uv, float frame, float columns, float rows) {
  float row = floor((frame + 0.5) / columns);
  float column = frame - row * columns;
  return vec2((column + uv.x) / columns, 1.0 - (row + 1.0 - uv.y) / rows);
}`,
    requires: everyTier(),
  },
];

/** Every helper of this file. */
export const LIBRARY_HELPERS: readonly FXGLSLHelperDefinition[] = [
  ...MATRIX_HELPERS,
  RAND,
  MESH_FETCH,
  SCENE_DEPTH_CONTACT,
  ...NODE_HELPERS,
];
