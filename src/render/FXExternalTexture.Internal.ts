import type { IUniform, Texture } from "three";

import type { FXRenderArtifact, FXValueSlot } from "../artifact/FXArtifact.js";
import type { FXExternalTexture, FXTextureRegion } from "./FXExternalTexture.js";

/**
 * The function a graph calls to sample an external texture uniform, `<name>(uv) -> vec4` - part of
 * the `fx` cross-repo ABI, like the lighting intrinsics: the compiler emits the call, the runtime
 * defines it per slot from what the host bound (see {@link externalSamplingFunctions}).
 */
export function fxExternalSampleFunction(uniformName: string): string {
  return `fxSample_${uniformName}`;
}

// Duck-typed, not `instanceof`: the app's `three` and this package's peer-dep `three` can be two
// separate module instances (e.g. hoisted differently across a workspace).
function isTexture(value: FXExternalTexture): value is Texture {
  return (value as { isTexture?: boolean }).isTexture === true;
}

/** The region uniforms of one slot: the two affine rows and, when masked, the bounds. */
function regionUniformNames(uniformName: string): {
  readonly rowU: string;
  readonly rowV: string;
  readonly bounds: string;
} {
  return {
    rowU: `fxRegionU_${uniformName}`,
    rowV: `fxRegionV_${uniformName}`,
    bounds: `fxRegionBounds_${uniformName}`,
  };
}

/** One external texture uniform's live slots. Its variant (plain / region / masked region) is fixed
 *  when built: switching it would need a new program, which a value edit never does. */
export interface FXExternalTextureBinding {
  /** The host's slot name (`external`), for messages: the uniform name is the binding's key. */
  readonly slot: string;
  readonly sampler: FXValueSlot<Texture>;
  readonly region?: {
    readonly rowU: FXValueSlot<number[]>;
    readonly rowV: FXValueSlot<number[]>;
    readonly bounds?: FXValueSlot<number[]>;
  };
}

/** Every external texture uniform's binding, by uniform name. */
export type FXExternalTextureBindings = Readonly<Record<string, FXExternalTextureBinding>>;

const IDENTITY: FXTextureRegion["uvTransform"] = [1, 0, 0, 0, 1, 0];
const FULL_BOUNDS: NonNullable<FXTextureRegion["uvBounds"]> = [0, 0, 1, 1];

function copyInto(target: number[], source: readonly number[], from: number, count: number): void {
  for (let i = 0; i < count; i++) {
    target[i] = source[from + i];
  }
}

/** Writes the window in place (no allocation per swap): a whole texture is the identity window. */
function writeRegion(
  region: NonNullable<FXExternalTextureBinding["region"]>,
  value: FXTextureRegion | undefined,
): void {
  const transform = value?.uvTransform ?? IDENTITY;
  copyInto(region.rowU.value, transform, 0, 3);
  copyInto(region.rowV.value, transform, 3, 3);
  if (region.bounds !== undefined) {
    copyInto(region.bounds.value, value?.uvBounds ?? FULL_BOUNDS, 0, 4);
  }
}

/**
 * A binding for every external texture uniform `render` declares, from the host's `textures` (by
 * slot name). A missing one fails fast here rather than surfacing as a blank sampler at draw time.
 * @param owner - Names the caller in the error, `hint` says where the textures come from.
 */
export function createExternalTextureBindings(
  render: FXRenderArtifact,
  textures: Readonly<Record<string, FXExternalTexture>>,
  owner: string,
  hint: string,
): Record<string, FXExternalTextureBinding> {
  const bindings: Record<string, FXExternalTextureBinding> = {};
  for (const name in render.uniforms) {
    const uniform = render.uniforms[name];
    if (!("external" in uniform)) {
      continue;
    }
    const slot = uniform.external;
    if (!(slot in textures)) {
      throw new Error(
        `${owner}: no texture supplied for external slot "${slot}" (uniform "${name}"); ${hint}`,
      );
    }
    const value = textures[slot];
    if (isTexture(value)) {
      bindings[name] = { slot, sampler: { value } };
      continue;
    }
    const region = {
      rowU: { value: [0, 0, 0] },
      rowV: { value: [0, 0, 0] },
      ...(value.uvBounds === undefined ? {} : { bounds: { value: [0, 0, 0, 0] } }),
    };
    writeRegion(region, value);
    bindings[name] = { slot, sampler: { value: value.texture }, region };
  }
  return bindings;
}

/**
 * Throws when `value` cannot be a value edit of `binding`: a variant the slot was not built with. A plain `Texture` fits every variant (a region slot then samples all of
 * it); a region needs a region slot, and its `uvBounds` a masked one. Checked before any write, so
 * a rejected edit leaves every slot as it was.
 */
export function assertExternalTexture(
  binding: FXExternalTextureBinding,
  value: FXExternalTexture,
  uniformName: string,
): void {
  const where = `external texture slot "${binding.slot}" (uniform "${uniformName}")`;
  if (isTexture(value)) {
    return;
  }
  if (binding.region === undefined) {
    throw new Error(
      `${where} was bound to a whole texture, so it cannot take a region; ` +
        "bind a region from the start to swap regions",
    );
  }
  if (value.uvBounds !== undefined && binding.region.bounds === undefined) {
    throw new Error(
      `${where} was bound to a region without uvBounds, so it cannot take a masked one; ` +
        "bind a masked region from the start",
    );
  }
}

/** A value edit of one bound slot, never a new program. Call {@link assertExternalTexture} first. */
export function writeExternalTexture(
  binding: FXExternalTextureBinding,
  value: FXExternalTexture,
): void {
  if (isTexture(value)) {
    binding.sampler.value = value;
    if (binding.region !== undefined) {
      writeRegion(binding.region, undefined);
    }
    return;
  }
  binding.sampler.value = value.texture;
  if (binding.region !== undefined) {
    writeRegion(binding.region, value);
  }
}

/** Wires every binding's slots into a material's uniforms by reference (live value edits). */
export function bindExternalTextures(
  uniforms: Record<string, IUniform>,
  bindings: FXExternalTextureBindings,
): void {
  for (const name in bindings) {
    const binding = bindings[name];
    uniforms[name] = binding.sampler;
    if (binding.region !== undefined) {
      const names = regionUniformNames(name);
      uniforms[names.rowU] = binding.region.rowU;
      uniforms[names.rowV] = binding.region.rowV;
      if (binding.region.bounds !== undefined) {
        uniforms[names.bounds] = binding.region.bounds;
      }
    }
  }
}

/**
 * The fragment-stage definitions of every bound slot's {@link fxExternalSampleFunction}, placed after
 * the artifact's uniform declarations (which declare the sampler). A plain slot is a macro over
 * `texture2D` - no cost at all. A region slot clamps the UV into the window (the hardware clamp
 * would clamp to the whole texture, reading the neighbour sprites), maps it, and when masked
 * zeroes what lies outside `uvBounds`.
 */
export function externalSamplingFunctions(bindings: FXExternalTextureBindings): string {
  const lines: string[] = [];
  for (const name in bindings) {
    const binding = bindings[name];
    const sample = fxExternalSampleFunction(name);
    if (binding.region === undefined) {
      lines.push(`#define ${sample}(uv) texture2D(${name}, (uv))`);
      continue;
    }
    const names = regionUniformNames(name);
    lines.push(`uniform vec3 ${names.rowU};`, `uniform vec3 ${names.rowV};`);
    if (binding.region.bounds !== undefined) {
      lines.push(`uniform vec4 ${names.bounds};`);
    }
    lines.push(
      `vec4 ${sample}(vec2 uv) {`,
      "  vec3 p = vec3(clamp(uv, 0.0, 1.0), 1.0);",
      `  vec4 color = texture2D(${name}, vec2(dot(${names.rowU}, p), dot(${names.rowV}, p)));`,
    );
    if (binding.region.bounds !== undefined) {
      lines.push(
        `  vec2 inside = step(${names.bounds}.xy, p.xy) * step(p.xy, ${names.bounds}.zw);`,
        "  color *= inside.x * inside.y;",
      );
    }
    lines.push("  return color;", "}");
  }
  return lines.join("\n");
}

/** The bindings' program variants, for the program cache key: one artifact bound two ways is two
 *  programs. Empty when every slot is plain, so a plain binding keeps the artifact's own key. */
export function externalSamplingKey(bindings: FXExternalTextureBindings): string {
  const variants: string[] = [];
  for (const name of Object.keys(bindings).sort()) {
    const region = bindings[name].region;
    if (region !== undefined) {
      variants.push(`${name}:${region.bounds === undefined ? "region" : "masked"}`);
    }
  }
  return variants.join(",");
}
