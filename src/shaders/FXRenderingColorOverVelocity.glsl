#define COLOR_OVER_VELOCITY_MAX // will be replaced with COLOR_OVER_VELOCITY_MAX <value>

vec4 draw() {
  float t = clamp(length(vec2(PARTICLE_VELOCITY_X, PARTICLE_VELOCITY_Y)) / COLOR_OVER_VELOCITY_MAX, 0.0, 1.0);
  return srgbTexture2D(p_colorOverVelocityTexture, vec2(t, 0.5));
}
