vec4 draw() {
  float totalFrames = p_count.x * p_count.y;
  float frame = floor(PARTICLE_AGE / PARTICLE_LIFETIME * totalFrames);
  frame = clamp(frame, 0.0, totalFrames - 1.0);

  float col = mod(frame, p_count.x);
  float row = floor(frame / p_count.x);

  vec2 frameSize = vec2(1.0 / p_count.x, 1.0 / p_count.y);
  vec2 uv = (p_uv + vec2(col, (p_count.y - 1.0 - row))) * frameSize;

  return srgbTexture2D(p_texture, uv);
}
