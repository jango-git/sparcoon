vec4 draw() {
  float shadow = 1.0;

  #ifdef USE_SHADOWMAP
    #if NUM_DIR_LIGHT_SHADOWS > 0
      vec4 sc = vDirectionalShadowCoord[0];
      sc.xyz /= sc.w;

      float depth = unpackRGBAToDepth(texture2D(directionalShadowMap[0], sc.xy));
      shadow = step(sc.z - 0.001, depth);
    #endif
  #endif

  return vec4(vec3(shadow), 1.0);
}
