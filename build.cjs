const path = require('node:path');
const esbuild = require(process.env.ESBUILD_MODULE || 'esbuild');
esbuild.build({
  absWorkingDir: __dirname,
  entryPoints: ['src/popup.jsx'], outfile: 'popup.js', bundle: true, format: 'esm',
  platform: 'browser', target: 'chrome112', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'external', charset: 'utf8',
  nodePaths: process.env.BILI_BUILD_NODE_MODULES ? [path.resolve(process.env.BILI_BUILD_NODE_MODULES)] : []
}).catch(error => { console.error(error); process.exitCode = 1; });
