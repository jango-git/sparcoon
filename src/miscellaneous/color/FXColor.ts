import { Color, MathUtils, Vector4 } from "three";
import { assertValidNumber } from "../asserts";
import { linearToSRGB, srgbToLinear } from "../math";
import type { FXColorConfig, FXColorName } from "./FXColor.Internal";
import { COLORS } from "./FXColor.Internal";

/** RGBA color with RGB, HSL, hex, and named color support */
export class FXColor {
  private rInternal = 1;
  private gInternal = 1;
  private bInternal = 1;
  private aInternal = 1;

  private hInternal = 0;
  private sInternal = 0;
  private lInternal = 1;

  private dirtyInternal = false;
  private rgbDirty = false;
  private hslDirty = false;

  constructor();
  /**
   * @param r - Red (0-1)
   * @param g - Green (0-1)
   * @param b - Blue (0-1)
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  constructor(r: number, g: number, b: number, a?: number);
  /**
   * @param colorName - Named color
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  constructor(colorName: FXColorName, a?: number);
  /**
   * @param threeColor - Three.js Color object
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  constructor(threeColor: Color, a?: number);
  /**
   * @param hexRGB - Hex RGB value (e.g., 0xff0000)
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  constructor(hexRGB: number, a?: number);
  /**
   * @param hexString - Hex string (e.g., "#ffffff" or "#ffffffff")
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  constructor(hexString?: string);
  /**
   * @param uiColor - FXColor object to copy from
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  constructor(uiColor?: FXColor);
  /**
   * @param uiColorConfig - FXColorConfig object
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  constructor(uiColorConfig?: FXColorConfig);
  constructor(...args: unknown[]) {
    if (args.length > 0) {
      (this.set as (...a: unknown[]) => this)(...args);
    }
  }

  /** Black (0x000000) */
  public static get black(): FXColor {
    return new FXColor("black");
  }

  /** White (0xffffff) */
  public static get white(): FXColor {
    return new FXColor("white");
  }

  /** Red (0xff0000) */
  public static get red(): FXColor {
    return new FXColor("red");
  }

  /** Green (0x008000) */
  public static get green(): FXColor {
    return new FXColor("green");
  }

  /** Blue (0x0000ff) */
  public static get blue(): FXColor {
    return new FXColor("blue");
  }

  /** Yellow (0xffff00) */
  public static get yellow(): FXColor {
    return new FXColor("yellow");
  }

  /** Cyan (0x00ffff) */
  public static get cyan(): FXColor {
    return new FXColor("cyan");
  }

  /** Magenta (0xff00ff) */
  public static get magenta(): FXColor {
    return new FXColor("magenta");
  }

  /** Gray (0x808080) */
  public static get gray(): FXColor {
    return new FXColor("gray");
  }

  /** Grey (0x808080) */
  public static get grey(): FXColor {
    return new FXColor("grey");
  }

  /** Silver (0xc0c0c0) */
  public static get silver(): FXColor {
    return new FXColor("silver");
  }

  /** Maroon (0x800000) */
  public static get maroon(): FXColor {
    return new FXColor("maroon");
  }

  /** Olive (0x808000) */
  public static get olive(): FXColor {
    return new FXColor("olive");
  }

  /** Lime (0x00ff00) */
  public static get lime(): FXColor {
    return new FXColor("lime");
  }

  /** Aqua (0x00ffff) */
  public static get aqua(): FXColor {
    return new FXColor("aqua");
  }

  /** Teal (0x008080) */
  public static get teal(): FXColor {
    return new FXColor("teal");
  }

  /** Navy (0x000080) */
  public static get navy(): FXColor {
    return new FXColor("navy");
  }

  /** Fuchsia (0xff00ff) */
  public static get fuchsia(): FXColor {
    return new FXColor("fuchsia");
  }

  /** Purple (0x800080) */
  public static get purple(): FXColor {
    return new FXColor("purple");
  }

  /** Orange (0xffa500) */
  public static get orange(): FXColor {
    return new FXColor("orange");
  }

  /** Pink (0xffc0cb) */
  public static get pink(): FXColor {
    return new FXColor("pink");
  }

  /** Brown (0xa52a2a) */
  public static get brown(): FXColor {
    return new FXColor("brown");
  }

  /** Gold (0xffd700) */
  public static get gold(): FXColor {
    return new FXColor("gold");
  }

  /** Violet (0xee82ee) */
  public static get violet(): FXColor {
    return new FXColor("violet");
  }

  /** Indigo (0x4b0082) */
  public static get indigo(): FXColor {
    return new FXColor("indigo");
  }

  /** Coral (0xff7f50) */
  public static get coral(): FXColor {
    return new FXColor("coral");
  }

  /** Salmon (0xfa8072) */
  public static get salmon(): FXColor {
    return new FXColor("salmon");
  }

  /** Khaki (0xf0e68c) */
  public static get khaki(): FXColor {
    return new FXColor("khaki");
  }

  /** Plum (0xdda0dd) */
  public static get plum(): FXColor {
    return new FXColor("plum");
  }

  /** Orchid (0xda70d6) */
  public static get orchid(): FXColor {
    return new FXColor("orchid");
  }

  /** Tan (0xd2b48c) */
  public static get tan(): FXColor {
    return new FXColor("tan");
  }

  /** Beige (0xf5f5dc) */
  public static get beige(): FXColor {
    return new FXColor("beige");
  }

  /** Mint (0x98fb98) */
  public static get mint(): FXColor {
    return new FXColor("mint");
  }

  /** Lavender (0xe6e6fa) */
  public static get lavender(): FXColor {
    return new FXColor("lavender");
  }

  /** Crimson (0xdc143c) */
  public static get crimson(): FXColor {
    return new FXColor("crimson");
  }

  /** Azure (0xf0ffff) */
  public static get azure(): FXColor {
    return new FXColor("azure");
  }

  /** Ivory (0xfffff0) */
  public static get ivory(): FXColor {
    return new FXColor("ivory");
  }

  /** Snow (0xfffafa) */
  public static get snow(): FXColor {
    return new FXColor("snow");
  }

  /** Red component (0 to 1) */
  public get r(): number {
    this.ensureRGBUpdatedFromHSL();
    return this.rInternal;
  }

  /** Green component (0 to 1) */
  public get g(): number {
    this.ensureRGBUpdatedFromHSL();
    return this.gInternal;
  }

  /** Blue component (0 to 1) */
  public get b(): number {
    this.ensureRGBUpdatedFromHSL();
    return this.bInternal;
  }

  /** Alpha component (0 to 1) */
  public get a(): number {
    return this.aInternal;
  }

  /** Hue component (0 to 360) */
  public get hue(): number {
    this.ensureHSLUpdatedFromRGB();
    return this.hInternal;
  }

  /** Saturation component (0 to 1) */
  public get saturation(): number {
    this.ensureHSLUpdatedFromRGB();
    return this.sInternal;
  }

  /** Lightness component (0 to 1) */
  public get lightness(): number {
    this.ensureHSLUpdatedFromRGB();
    return this.lInternal;
  }

  /** @internal */
  public get dirty(): boolean {
    return this.dirtyInternal;
  }

  /** Red component (0 to 1) */
  public set r(value: number) {
    assertValidNumber(value, "FXColor.r");
    value = MathUtils.clamp(value, 0, 1);
    this.ensureRGBUpdatedFromHSL();
    if (value !== this.rInternal) {
      this.rInternal = value;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }
  }

  /** Green component (0 to 1) */
  public set g(value: number) {
    assertValidNumber(value, "FXColor.g");
    value = MathUtils.clamp(value, 0, 1);
    this.ensureRGBUpdatedFromHSL();
    if (value !== this.gInternal) {
      this.gInternal = value;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }
  }

  /** Blue component (0 to 1) */
  public set b(value: number) {
    assertValidNumber(value, "FXColor.b");
    value = MathUtils.clamp(value, 0, 1);
    this.ensureRGBUpdatedFromHSL();
    if (value !== this.bInternal) {
      this.bInternal = value;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }
  }

  /** Alpha component (0 to 1) */
  public set a(value: number) {
    assertValidNumber(value, "FXColor.a");
    value = MathUtils.clamp(value, 0, 1);
    if (value !== this.aInternal) {
      this.aInternal = value;
      this.dirtyInternal = true;
    }
  }

  /** Hue component (0 to 360) */
  public set hue(value: number) {
    assertValidNumber(value, "FXColor.hue");
    value = MathUtils.clamp(value, 0, 360);
    this.ensureHSLUpdatedFromRGB();
    if (value !== this.hInternal) {
      this.hInternal = value;
      this.rgbDirty = true;
      this.dirtyInternal = true;
    }
  }

  /** Saturation component (0 to 1) */
  public set saturation(value: number) {
    assertValidNumber(value, "FXColor.saturation");
    value = MathUtils.clamp(value, 0, 1);
    this.ensureHSLUpdatedFromRGB();
    if (value !== this.sInternal) {
      this.sInternal = value;
      this.rgbDirty = true;
      this.dirtyInternal = true;
    }
  }

  /** Lightness component (0 to 1) */
  public set lightness(value: number) {
    assertValidNumber(value, "FXColor.lightness");
    value = MathUtils.clamp(value, 0, 1);
    this.ensureHSLUpdatedFromRGB();
    if (value !== this.lInternal) {
      this.lInternal = value;
      this.rgbDirty = true;
      this.dirtyInternal = true;
    }
  }

  /** @internal */
  public setDirtyFalse(): void {
    this.dirtyInternal = false;
  }

  /** Sets to white (default) */
  public set(): this;
  /**
   * @param r - Red (0-1)
   * @param g - Green (0-1)
   * @param b - Blue (0-1)
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  public set(r: number, g: number, b: number, a?: number): this;
  /**
   * @param colorName - Named color
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  public set(colorName: FXColorName, a?: number): this;
  /**
   * @param threeColor - Three.js Color object
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  public set(threeColor: Color, a?: number): this;
  /**
   * @param hexRGB - Hex RGB value (e.g., 0xff0000)
   * @param a - Alpha (0-1)
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  public set(hexRGB: number, a?: number): this;
  /**
   * @param hexString - Hex string (e.g., "#ffffff" or "#ffffffff")
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  public set(hexString: string): this;
  /**
   * @param uiColor - FXColor object to copy from
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  public set(uiColor: FXColor): this;
  /**
   * @param uiColorConfig - FXColorConfig object
   */
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- Separate overloads make the different constructor patterns more clear
  public set(uiColorConfig?: FXColorConfig): this;
  public set(...args: unknown[]): this {
    if (args.length === 0 || args[0] === undefined) {
      return this.setRGBA(1, 1, 1, 1);
    }

    if (args.length >= 3 && typeof args[0] === "number") {
      const [r, g, b, a = 1] = args as number[];
      return this.setRGBA(r, g, b, a);
    }

    const [firstArgument, a = 1] = args;

    if (typeof firstArgument === "string") {
      return firstArgument.startsWith("#")
        ? this.setHexString(firstArgument)
        : this.setColorName(firstArgument as FXColorName, a as number);
    }

    if (firstArgument instanceof FXColor) {
      return this.copy(firstArgument);
    }

    if (firstArgument instanceof Color) {
      return this.setThreeColor(firstArgument, a as number);
    }

    if (typeof firstArgument === "number") {
      return this.setHexRGB(firstArgument, a as number);
    }

    throw new Error("FXColor.set: cannot create color from provided arguments");
  }

  /** Sets RGBA components directly */
  public setRGBA(r: number, g: number, b: number, a: number = this.aInternal): this {
    assertValidNumber(r, "FXColor.setRGBA.r");
    assertValidNumber(g, "FXColor.setRGBA.g");
    assertValidNumber(b, "FXColor.setRGBA.b");
    assertValidNumber(a, "FXColor.setRGBA.a");
    r = MathUtils.clamp(r, 0, 1);
    g = MathUtils.clamp(g, 0, 1);
    b = MathUtils.clamp(b, 0, 1);
    a = MathUtils.clamp(a, 0, 1);
    this.ensureRGBUpdatedFromHSL();
    if (
      r !== this.rInternal ||
      g !== this.gInternal ||
      b !== this.bInternal ||
      a !== this.aInternal
    ) {
      this.rInternal = r;
      this.gInternal = g;
      this.bInternal = b;
      this.aInternal = a;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }
    return this;
  }

  /** Returns RGBA as 32-bit hex (RRGGBBAA) */
  public getHexRGBA(): number {
    this.ensureRGBUpdatedFromHSL();
    return (
      (Math.round(this.rInternal * 255) << 24) |
      (Math.round(this.gInternal * 255) << 16) |
      (Math.round(this.bInternal * 255) << 8) |
      Math.round(this.aInternal * 255)
    );
  }

  /** Returns RGB as 24-bit hex (RRGGBB) */
  public getHexRGB(): number {
    this.ensureRGBUpdatedFromHSL();
    return (
      (Math.round(this.rInternal * 255) << 16) |
      (Math.round(this.gInternal * 255) << 8) |
      Math.round(this.bInternal * 255)
    );
  }

  /** Returns RGB as hex string ("#ffffff") */
  public getHexStringRGB(): string {
    const hex = this.getHexRGB();
    return `#${hex.toString(16).padStart(6, "0")}`;
  }

  /** Returns RGBA as hex string ("#ffffffff") */
  public getHexStringRGBA(): string {
    const hex = this.getHexRGBA();
    return `#${hex.toString(16).padStart(8, "0")}`;
  }

  /** Sets from 32-bit hex RGBA (RRGGBBAA) */
  public setHexRGBA(hex: number): this {
    assertValidNumber(hex, "FXColor.setHexRGBA.hex");
    this.ensureRGBUpdatedFromHSL();
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    const a = ((hex >> 24) & 0xff) / 255;
    if (
      r !== this.rInternal ||
      g !== this.gInternal ||
      b !== this.bInternal ||
      a !== this.aInternal
    ) {
      this.rInternal = r;
      this.gInternal = g;
      this.bInternal = b;
      this.aInternal = a;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }
    return this;
  }

  /** Sets from 24-bit hex RGB (RRGGBB) */
  public setHexRGB(hex: number, a = this.aInternal): this {
    assertValidNumber(hex, "FXColor.setHexRGB.hex");
    assertValidNumber(a, "FXColor.setHexRGB.a");
    a = MathUtils.clamp(a, 0, 1);
    this.ensureRGBUpdatedFromHSL();
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    if (
      r !== this.rInternal ||
      g !== this.gInternal ||
      b !== this.bInternal ||
      a !== this.aInternal
    ) {
      this.rInternal = r;
      this.gInternal = g;
      this.bInternal = b;
      this.aInternal = a;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }
    return this;
  }

  /**
   * Sets from hex string.
   *
   * @param hexString - Format: "#ffffff" or "#ffffffff"
   * @throws If format invalid
   */
  public setHexString(hexString: string): this {
    if (!hexString.startsWith("#")) {
      throw new Error(
        `FXColor.setHexString.hexString: invalid hex string format. expected format: "#ffffff" or "#ffffffff"`,
      );
    }

    const hex = hexString.slice(1);

    if (hex.length === 6) {
      const hexNumber = parseInt(hex, 16);
      if (isNaN(hexNumber)) {
        throw new Error(
          `FXColor.setHexString.hexString: invalid hex string format. expected format: "#ffffff" or "#ffffffff"`,
        );
      }
      return this.setHexRGB(hexNumber);
    } else if (hex.length === 8) {
      const hexNumber = parseInt(hex, 16);
      if (isNaN(hexNumber)) {
        throw new Error(
          `FXColor.setHexString.hexString: invalid hex string format. expected format: "#ffffff" or "#ffffffff"`,
        );
      }
      return this.setHexRGBA(hexNumber);
    } else {
      throw new Error(
        `FXColor.setHexString.hexString: invalid hex string format. expected format: "#ffffff" or "#ffffffff"`,
      );
    }
  }

  /** Sets from HSL values */
  public setHSL(h: number, s: number, l: number, a = this.aInternal): this {
    assertValidNumber(h, "FXColor.setHSL.h");
    assertValidNumber(s, "FXColor.setHSL.s");
    assertValidNumber(l, "FXColor.setHSL.l");
    assertValidNumber(a, "FXColor.setHSL.a");
    h = MathUtils.clamp(h, 0, 360);
    s = MathUtils.clamp(s, 0, 1);
    l = MathUtils.clamp(l, 0, 1);
    a = MathUtils.clamp(a, 0, 1);
    this.ensureHSLUpdatedFromRGB();
    if (
      h !== this.hInternal ||
      s !== this.sInternal ||
      l !== this.lInternal ||
      a !== this.aInternal
    ) {
      this.hInternal = h;
      this.sInternal = s;
      this.lInternal = l;
      this.aInternal = a;
      this.rgbDirty = true;
      this.dirtyInternal = true;
    }
    return this;
  }

  /**
   * Sets from predefined name.
   *
   * @throws If color name unknown
   */
  public setColorName(colorName: FXColorName, a = this.aInternal): this {
    assertValidNumber(a, "FXColor.setColorName.a");
    a = MathUtils.clamp(a, 0, 1);
    const normalizedName = colorName.toLowerCase().trim();
    const hex = COLORS[normalizedName];

    if (hex === undefined) {
      throw new Error(`FXColor.setColorName.colorName: unknown color name`);
    }

    return this.setHexRGB(hex, a);
  }

  /** Sets from linear (GLSL) color space */
  public setGLSLColor(r: number, g: number, b: number, a = this.aInternal): this {
    assertValidNumber(r, "FXColor.setGLSLColor.r");
    assertValidNumber(g, "FXColor.setGLSLColor.g");
    assertValidNumber(b, "FXColor.setGLSLColor.b");
    assertValidNumber(a, "FXColor.setGLSLColor.a");
    a = MathUtils.clamp(a, 0, 1);
    this.ensureRGBUpdatedFromHSL();

    const sRGBR = linearToSRGB(r);
    const sRGBG = linearToSRGB(g);
    const sRGBB = linearToSRGB(b);

    if (
      sRGBR !== this.rInternal ||
      sRGBG !== this.gInternal ||
      sRGBB !== this.bInternal ||
      a !== this.aInternal
    ) {
      this.rInternal = sRGBR;
      this.gInternal = sRGBG;
      this.bInternal = sRGBB;
      this.aInternal = a;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }

    return this;
  }

  /** Sets from Three.js Color */
  public setThreeColor(threeColor: Color, a = this.aInternal): this {
    assertValidNumber(a, "FXColor.setThreeColor.a");
    a = MathUtils.clamp(a, 0, 1);
    this.ensureRGBUpdatedFromHSL();
    if (
      threeColor.r !== this.rInternal ||
      threeColor.g !== this.gInternal ||
      threeColor.b !== this.bInternal ||
      a !== this.aInternal
    ) {
      this.rInternal = threeColor.r;
      this.gInternal = threeColor.g;
      this.bInternal = threeColor.b;
      this.aInternal = a;
      this.hslDirty = true;
      this.dirtyInternal = true;
    }
    return this;
  }

  /** Returns CSS color string ("rgba(255, 0, 0, 1)") */
  public toCSSColor(): string {
    this.ensureRGBUpdatedFromHSL();
    const r = Math.round(this.rInternal * 255);
    const g = Math.round(this.gInternal * 255);
    const b = Math.round(this.bInternal * 255);
    return `rgba(${r}, ${g}, ${b}, ${this.aInternal})`;
  }

  /** Converts to linear (GLSL) color space */
  public toGLSLColor(result: Vector4 = new Vector4()): Vector4 {
    this.ensureRGBUpdatedFromHSL();

    result.x = srgbToLinear(this.rInternal);
    result.y = srgbToLinear(this.gInternal);
    result.z = srgbToLinear(this.bInternal);
    result.w = this.aInternal;

    return result;
  }

  /** Converts to Three.js Color (without alpha) */
  public toThreeColor(result: Color = new Color()): Color {
    this.ensureRGBUpdatedFromHSL();

    result.r = this.rInternal;
    result.g = this.gInternal;
    result.b = this.bInternal;

    return result;
  }

  /** Copies from another color */
  public copy(color: FXColor | Color): this {
    if (color instanceof FXColor) {
      this.ensureRGBUpdatedFromHSL();
      color.ensureRGBUpdatedFromHSL();

      if (
        this.rInternal !== color.rInternal ||
        this.gInternal !== color.gInternal ||
        this.bInternal !== color.bInternal ||
        this.aInternal !== color.aInternal
      ) {
        this.rInternal = color.rInternal;
        this.gInternal = color.gInternal;
        this.bInternal = color.bInternal;
        this.aInternal = color.aInternal;
        this.hslDirty = true;
        this.dirtyInternal = true;
      }
    } else {
      this.ensureRGBUpdatedFromHSL();
      if (
        this.rInternal !== color.r ||
        this.gInternal !== color.g ||
        this.bInternal !== color.b ||
        this.aInternal !== 1
      ) {
        this.rInternal = color.r;
        this.gInternal = color.g;
        this.bInternal = color.b;
        this.aInternal = 1;
        this.hslDirty = true;
        this.dirtyInternal = true;
      }
    }

    return this;
  }

  /** Returns copy of this color */
  public clone(): FXColor {
    this.ensureRGBUpdatedFromHSL();
    return new FXColor(this.rInternal, this.gInternal, this.bInternal, this.aInternal);
  }

  /** @internal */
  private ensureRGBUpdatedFromHSL(): void {
    if (this.rgbDirty) {
      const { hInternal: h, sInternal: s, lInternal: l } = this;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const hp = h / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      let [r, g, b] =
        hp < 1
          ? [c, x, 0]
          : hp < 2
            ? [x, c, 0]
            : hp < 3
              ? [0, c, x]
              : hp < 4
                ? [0, x, c]
                : hp < 5
                  ? [x, 0, c]
                  : [c, 0, x];

      const m = l - c / 2;
      this.rInternal = r + m;
      this.gInternal = g + m;
      this.bInternal = b + m;
      this.rgbDirty = false;
    }
  }

  private ensureHSLUpdatedFromRGB(): void {
    if (this.hslDirty) {
      const { rInternal: r, gInternal: g, bInternal: b } = this;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const l = (max + min) / 2;

      let h = 0;
      if (d !== 0) {
        if (max === r) {
          h = (g - b) / d + (g < b ? 6 : 0);
        } else if (max === g) {
          h = (b - r) / d + 2;
        } else {
          h = (r - g) / d + 4;
        }
        h *= 60;
      }

      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      this.hInternal = h;
      this.sInternal = s;
      this.lInternal = l;
      this.hslDirty = false;
    }
  }
}
