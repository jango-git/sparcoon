/**
 * How per-particle fields are packed into vertex attributes - the one place that decides it.
 *
 * Vertex-attribute slots are what a particle or trail shader runs out of first: WebGL1 guarantees
 * only 8 (and the base geometry takes up to three of them), WebGL2 16. An attribute is a view of at
 * most four floats, so a field narrower than that - a float alpha, a vec2 offset - wastes the rest
 * of its slot when it gets one of its own. Packing lets several fields that lie side by side in one
 * buffer share one view (`vec4(color.rgb, alpha)`), and the shader splits it back apart with a
 * swizzle. Varyings are not packed here: the driver already packs those itself, and the render
 * budget counts them by the GLSL packing rules.
 *
 * Two steps, split by who owns them:
 * - {@link packingOrder}: whoever lays a buffer out (the CPU trail history, the editor ordering a
 *   GPU kernel's buffers) asks for a packing-friendly order of its fields, and lays them out in it.
 * - {@link packConsecutive}: given the fields as they then lie in memory, groups adjacent ones into
 *   views. It is correct for any layout; only how few views it needs depends on the order.
 *
 * Three-free and dependency-free: the editor imports this too (through `sparcoon/editor`), so a
 * kernel it lays out and the views the runtime binds over it agree by construction.
 */

/** The most floats one vertex attribute can carry (a vec4). */
export const FX_ATTRIBUTE_MAX_COMPONENTS = 4;

// Indexed by component count.
const FLOAT_TYPES: readonly string[] = ["", "float", "vec2", "vec3", "vec4"];

/**
 * The GLSL type of `components` floats - `float`, `vec2`, `vec3` or `vec4` - for a field, a packed
 * view or a kernel buffer alike.
 * @param context - Who asks, prefixed to the error.
 * @throws A `RangeError` outside 1..{@link FX_ATTRIBUTE_MAX_COMPONENTS}.
 */
export function floatGLSLType(components: number, context = "floatGLSLType"): string {
  const type = Number.isInteger(components) ? FLOAT_TYPES[components] : undefined;
  if (type === undefined || type === "") {
    throw new RangeError(
      `${context}: no GLSL float type of ${String(components)} components (expected 1..4)`,
    );
  }
  return type;
}

/** A named field of 1..4 floats. */
export interface FXPackingField {
  readonly name: string;
  readonly components: number;
}

/** A field where it lies in memory: `offset` floats from the start of its record (slot, point). */
export interface FXPlacedField extends FXPackingField {
  readonly offset: number;
}

/** One field's share of a packed view: its components start at `componentOffset` of the view. */
export interface FXPackedMember {
  readonly name: string;
  readonly components: number;
  readonly componentOffset: number;
}

/**
 * One vertex attribute: a view of `components` (1..4) consecutive floats at `offset` of a record,
 * carrying `members` in component order. A view may also span floats no member claims (see
 * {@link FXPackConsecutiveOptions.reads}); a consumer just never swizzles them out.
 */
export interface FXPackedAttribute {
  readonly name: string;
  readonly offset: number;
  readonly components: number;
  readonly members: readonly FXPackedMember[];
}

export interface FXPackConsecutiveOptions {
  /**
   * Which fields the consumer reads (default: all). A field it does not read never gets a view of
   * its own and is never a member, but a view may still span it to reach a read field lying right
   * after it - harmless (the floats are in the same buffer either way, just never swizzled out),
   * and it can save a view: `[a, unread, b]` of one float each is one vec3 view instead of two.
   * A view never starts or ends on an unread field.
   */
  readonly reads?: (name: string) => boolean;
}

function assertComponents(field: FXPackingField): void {
  if (
    !Number.isInteger(field.components) ||
    field.components < 1 ||
    field.components > FX_ATTRIBUTE_MAX_COMPONENTS
  ) {
    throw new RangeError(
      `FXAttributePacking: field "${field.name}" has ${String(field.components)} components; ` +
        `expected 1..${String(FX_ATTRIBUTE_MAX_COMPONENTS)}`,
    );
  }
}

function assertUniqueNames(fields: readonly FXPackingField[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) {
      throw new Error(`FXAttributePacking: field "${field.name}" is listed twice`);
    }
    names.add(field.name);
  }
}

/** Code-unit order: deterministic in every locale, unlike `localeCompare`. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A packing-friendly order of `fields`: first-fit decreasing into vec4-sized bins, the bins one
 * after another. Widest fields first (ties by name, so the order depends only on the set of fields,
 * never on the order they are listed in), each into the first bin it still fits, so a bin fills as
 * `vec3 + float`, `vec2 + vec2`, `vec2 + float + float` or four floats. Laid out back to back in
 * this order, {@link packConsecutive} then needs exactly one view per bin - each bin's first field
 * did not fit the bin before it, so no view runs over a bin's end.
 *
 * Takes the core fields as any other (`position` and `lifecycle` are vec3s - each pairs with a
 * float). Throws for a width outside 1..4 or a name listed twice.
 */
export function packingOrder<T extends FXPackingField>(fields: readonly T[]): T[] {
  fields.forEach(assertComponents);
  assertUniqueNames(fields);
  const sorted = [...fields].sort(
    (a, b) => b.components - a.components || compareNames(a.name, b.name),
  );
  const bins: { free: number; fields: T[] }[] = [];
  for (const field of sorted) {
    let bin = bins.find((candidate) => candidate.free >= field.components);
    if (bin === undefined) {
      bin = { free: FX_ATTRIBUTE_MAX_COMPONENTS, fields: [] };
      bins.push(bin);
    }
    bin.fields.push(field);
    bin.free -= field.components;
  }
  return bins.flatMap((bin) => bin.fields);
}

/**
 * Groups `fields` - as they lie in memory, in any order, contiguous or not - into vertex attribute
 * views of at most four floats: walking them by offset, a field joins the current view when it
 * starts exactly where the view ends and still fits; otherwise it starts a new one. So only
 * adjacent fields ever share a view, whatever the layout - correct for any order, and as tight as
 * {@link packingOrder} makes it for a layout in that order.
 *
 * @param name - The `index`-th view's attribute name (`pack0`, `pack1`, ...) - the caller's, so
 *   views over different buffers or ends of a segment stay distinct.
 * @throws For a width outside 1..4, a name listed twice, or fields that overlap.
 */
export function packConsecutive(
  fields: readonly FXPlacedField[],
  name: (index: number) => string,
  options: FXPackConsecutiveOptions = {},
): FXPackedAttribute[] {
  fields.forEach(assertComponents);
  assertUniqueNames(fields);
  const reads = options.reads ?? ((): boolean => true);
  const sorted = [...fields].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1];
    if (sorted[i].offset < before.offset + before.components) {
      throw new Error(
        `FXAttributePacking: fields "${before.name}" and "${sorted[i].name}" overlap in memory`,
      );
    }
  }

  // The view being grown: its start, its fields so far (unread ones included, as bridges), and
  // how many of those end on a read field - a view closes trimmed to that.
  const packed: FXPackedAttribute[] = [];
  let start = 0;
  let spanned: FXPlacedField[] = [];
  let kept = 0;
  const close = (): void => {
    if (kept > 0) {
      const last = spanned[kept - 1];
      const members = spanned
        .slice(0, kept)
        .filter((field) => reads(field.name))
        .map((field) => ({
          name: field.name,
          components: field.components,
          componentOffset: field.offset - start,
        }));
      packed.push({
        name: name(packed.length),
        offset: start,
        components: last.offset + last.components - start,
        members,
      });
    }
    spanned = [];
    kept = 0;
  };
  for (const field of sorted) {
    const read = reads(field.name);
    const end = spanned.length > 0 ? spanned[spanned.length - 1] : undefined;
    const joins =
      end !== undefined &&
      field.offset === end.offset + end.components &&
      field.offset + field.components - start <= FX_ATTRIBUTE_MAX_COMPONENTS;
    if (!joins) {
      close();
      if (!read) {
        // Never opens a view: it could only ever bridge into one.
        continue;
      }
      start = field.offset;
    }
    spanned.push(field);
    if (read) {
      kept = spanned.length;
    }
  }
  close();
  return packed;
}
