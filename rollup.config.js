import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "rollup-plugin-typescript2";
import minifyPrivatesTransformer from "ts-transformer-minify-privates";
import { string } from "rollup-plugin-string";

const sharedPlugins = [
  nodeResolve({ extensions: [".js", ".ts"] }),
  {
    name: "minify-shaders",
    transform(code, id) {
      if (/\.(glsl|fs|vs|frag|vert)$/.test(id)) {
        return {
          code: code
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "")
            .replace(/\s*([{}(),=;+\-*/<>])\s*/g, "$1")
            .replace(/\s+/g, " ")
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
];

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
  plugins: sharedPlugins,
};
