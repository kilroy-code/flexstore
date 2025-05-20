import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';

/*
  We can (and have) arranged for index.mjs to be directly importable in browsers and NodeJS,
  but that involves a dynamic import of wrtc for NodeJS, but that makes things trick for apps
  that use this package, and which themselves try to bundle. (It can be done, but you need to
  arrange for build-time resolution of environment-based conditionals.

  So, I think it's easier on everyone if this package uses a builder, and "subpath imports".
 */

const devMode = (process.env.NODE_ENV === 'development');
// E.g., npx rollup -c --environment NODE_ENV:development
console.log(`${ devMode ? 'development' : 'production' } mode bundle`);

function target(input, output) { // roll up input to output
  return {
    input,
    output: {
      file: output,
      format: 'es',
      inlineDynamicImports: true,
      sourcemap: devMode ? 'inline' : false
    },
    external: [
      // Should stand alone rather than be bundled with flexstore. As a consequence, a Web page's import-map must specify
      // something like this, with distributed-security's files hosted on another origin:
      // "@ki1r0y/distributed-security": "https://cloud.ki1r0y.com/@ki1r0y/distributed-security/dist/index-bundle.mjs",
      // "@kilroy-code/flexstore": "/@kilroy-code/flexstore/bundle.mjs",

      '@ki1r0y/distributed-security'
    ],
    plugins: [
      nodeResolve({browser: true, preferBuiltins: false}), // Resolve package.json imports.
      json(),
      !devMode && terser({keep_classnames: true}) // minify for production.
    ]
  };
}

export default [
  target('index.mjs', 'bundle.mjs')
];

