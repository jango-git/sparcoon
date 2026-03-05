import type { IUniform, ShaderMaterial } from "three";
import { Matrix3, Matrix4, Texture, Vector2, Vector3, Vector4 } from "three";
import { FXColor } from "../color/FXColor";

export type FXProperty =
  | Texture
  | FXColor
  | Vector2
  | Vector3
  | Vector4
  | Matrix3
  | Matrix4
  | number;

export type FXPropertyName =
  | "Texture"
  | "UIColor"
  | "Vector2"
  | "Vector3"
  | "Vector4"
  | "Matrix3"
  | "Matrix4"
  | "number";

export type FXPropertyConstructor =
  | typeof Texture
  | typeof FXColor
  | typeof Vector2
  | typeof Vector3
  | typeof Vector4
  | typeof Matrix3
  | typeof Matrix4
  | NumberConstructor;

export type FXPropertyCopyTo = FXColor | Vector2 | Vector3 | Vector4 | Matrix3 | Matrix4;

export type FXPropertyCopyFrom = FXColor & Vector2 & Vector3 & Vector4 & Matrix3 & Matrix4;

export interface GLTypeInfo {
  glslTypeName: string;
  bufferSize: number;
  instantiable: boolean;
}

export interface GLProperty {
  value: FXProperty;
  glslTypeInfo: GLTypeInfo;
}

export interface PlaneData {
  source: string;
  properties: Record<string, GLProperty>;
  transform: Matrix4;
  visibility: boolean;
}

const GLSL_TYPE_INFO_FLOAT: GLTypeInfo = Object.freeze({
  glslTypeName: "float",
  bufferSize: 1,
  instantiable: true,
} as const);

const GLSL_TYPE_INFO_SAMPLER2D: GLTypeInfo = Object.freeze({
  glslTypeName: "sampler2D",
  bufferSize: -1,
  instantiable: false,
} as const);

const GLSL_TYPE_INFO_VEC2: GLTypeInfo = Object.freeze({
  glslTypeName: "vec2",
  bufferSize: 2,
  instantiable: true,
} as const);

const GLSL_TYPE_INFO_VEC3: GLTypeInfo = Object.freeze({
  glslTypeName: "vec3",
  bufferSize: 3,
  instantiable: true,
} as const);

const GLSL_TYPE_INFO_VEC4: GLTypeInfo = Object.freeze({
  glslTypeName: "vec4",
  bufferSize: 4,
  instantiable: true,
} as const);

const GLSL_TYPE_INFO_MAT3: GLTypeInfo = Object.freeze({
  glslTypeName: "mat3",
  bufferSize: 9,
  instantiable: true,
} as const);

const GLSL_TYPE_INFO_MAT4: GLTypeInfo = Object.freeze({
  glslTypeName: "mat4",
  bufferSize: 16,
  instantiable: true,
} as const);

export function resolveGLSLTypeInfo(
  value: FXProperty | FXPropertyName | FXPropertyConstructor,
): GLTypeInfo {
  if (typeof value === "string") {
    switch (value) {
      case "number":
        return GLSL_TYPE_INFO_FLOAT;
      case "Texture":
        return GLSL_TYPE_INFO_SAMPLER2D;
      case "UIColor":
        return GLSL_TYPE_INFO_VEC4;
      case "Vector2":
        return GLSL_TYPE_INFO_VEC2;
      case "Vector3":
        return GLSL_TYPE_INFO_VEC3;
      case "Vector4":
        return GLSL_TYPE_INFO_VEC4;
      case "Matrix3":
        return GLSL_TYPE_INFO_MAT3;
      case "Matrix4":
        return GLSL_TYPE_INFO_MAT4;
      default:
        throw new Error(`resolveGLSLTypeInfo.value: unsupported property type name`);
    }
  }
  if (typeof value === "function") {
    if (value === Number) {
      return GLSL_TYPE_INFO_FLOAT;
    }
    if (value === Texture) {
      return GLSL_TYPE_INFO_SAMPLER2D;
    }
    if (value === FXColor) {
      return GLSL_TYPE_INFO_VEC4;
    }
    if (value === Vector2) {
      return GLSL_TYPE_INFO_VEC2;
    }
    if (value === Vector3) {
      return GLSL_TYPE_INFO_VEC3;
    }
    if (value === Vector4) {
      return GLSL_TYPE_INFO_VEC4;
    }
    if (value === Matrix3) {
      return GLSL_TYPE_INFO_MAT3;
    }
    if (value === Matrix4) {
      return GLSL_TYPE_INFO_MAT4;
    }
    throw new Error(`resolveGLSLTypeInfo.value: unsupported property type constructor`);
  }
  if (typeof value === "number") {
    return GLSL_TYPE_INFO_FLOAT;
  }
  if (value instanceof Texture) {
    return GLSL_TYPE_INFO_SAMPLER2D;
  }
  if (value instanceof FXColor) {
    return GLSL_TYPE_INFO_VEC4;
  }
  if (value instanceof Vector2) {
    return GLSL_TYPE_INFO_VEC2;
  }
  if (value instanceof Vector3) {
    return GLSL_TYPE_INFO_VEC3;
  }
  if (value instanceof Vector4) {
    return GLSL_TYPE_INFO_VEC4;
  }
  if (value instanceof Matrix3) {
    return GLSL_TYPE_INFO_MAT3;
  }
  if (value instanceof Matrix4) {
    return GLSL_TYPE_INFO_MAT4;
  }
  throw new Error(`resolveGLSLTypeInfo.value: unsupported property type`);
}

export function resolvePropertyUniform(
  name: string,
  material: ShaderMaterial,
): IUniform<FXProperty> {
  const uniform = material.uniforms[`p_${name}`] as IUniform<FXProperty> | undefined;
  if (uniform === undefined) {
    throw new Error(`resolvePropertyUniform.name: unknown uniform`);
  }
  return uniform;
}
