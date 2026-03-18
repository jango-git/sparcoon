import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "rollup-plugin-typescript2";
import minifyPrivatesTransformer from "ts-transformer-minify-privates";
import { string } from "rollup-plugin-string";
import commonjs from "@rollup/plugin-commonjs";

export default {
  input: {
    index: "src/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    preserveModules: true,
    preserveModulesRoot: "src",
  },
  external: ["three", "ferrsign"],
  plugins: [
    nodeResolve({ extensions: [".js", ".ts"] }),
    commonjs(),
    {
      name: "minify-shaders",
      transform(code, id) {
        if (/\.(glsl|fs|vs|frag|vert)$/.test(id)) {
          return {
            code: code
              .replace(/\/\*[\s\S]*?\*\//g, "")
              .replace(/\/\/[^\n]*/g, "")
              .replace(/[ \t]*([{}(),=;+\-*/<>])[ \t]*/g, "$1")
              .replace(/[ \t]+/g, " ")
              .replace(/\n\s*\n/g, "\n")
              .trim(),
            map: null,
          };
        }
      },
    },
    string({
      include: ["**/*.glsl", "**/*.fs", "**/*.vs", "**/*.frag", "**/*.vert"],
    }),
    typescript({
      tsconfig: "tsconfig.json",
      useTsconfigDeclarationDir: true,
      transformers: [
        (service) => ({
          before: [minifyPrivatesTransformer.default(service.getProgram())],
          after: [],
        }),
      ],
    }),
  ],
};
