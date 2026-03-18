export const PARTICLE_DEFINES = `
  #define PARTICLE_POSITION_X p_builtin[0][0]
  #define PARTICLE_POSITION_Y p_builtin[0][1]
  #define PARTICLE_POSITION_Z p_builtin[0][2]

  #define PARTICLE_VELOCITY_X p_builtin[0][3]
  #define PARTICLE_VELOCITY_Y p_builtin[1][0]
  #define PARTICLE_VELOCITY_Z p_builtin[1][1]

  #define PARTICLE_SCALE_X p_builtin[1][2]
  #define PARTICLE_SCALE_Y p_builtin[1][3]
  #define PARTICLE_SCALE_Z p_builtin[2][0]

  #define PARTICLE_ROTATION p_builtin[2][1]
  #define PARTICLE_TORQUE p_builtin[2][2]

  #define PARTICLE_LIFETIME p_builtin[2][3]
  #define PARTICLE_AGE p_builtin[3][0]

  #define PARTICLE_RANDOM_A p_builtin[3][1]
  #define PARTICLE_RANDOM_B p_builtin[3][2]
  #define PARTICLE_RANDOM_C p_builtin[3][3]
`;
