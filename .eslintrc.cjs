/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "prettier",
  ],
  parserOptions: {
    project: ["./packages/*/tsconfig.json"],
    tsconfigRootDir: __dirname,
  },
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/prefer-readonly": "error",
    "no-console": "warn",
    "prefer-const": "error",
    "no-var": "error",
    eqeqeq: ["error", "always"],
  },
  ignorePatterns: ["dist/", "node_modules/", "*.js", "*.cjs", "*.mjs"],
};
