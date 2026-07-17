// GLTypeInfo (GLSL type name + float stride + instantiability). The emitter and material
// adapters size the per-particle buffers off these strides.

export interface GLTypeInfo {
  glslTypeName: string;
  bufferSize: number;
  instantiable: boolean;
}
