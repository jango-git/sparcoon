vec4 draw() {
  vec2 transformedUV = (p_textureTransform * vec3(p_uv, 1.0)).xy;
  return srgbTexture2D(p_texture, transformedUV);
}
