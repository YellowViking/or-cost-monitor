const esbuild = require('esbuild');
const prod = !process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: prod ? false : true,
  minify: prod,
  logLevel: 'info'
};

if (prod) {
  esbuild.build(options).catch(() => process.exit(1));
} else {
  const ctx = esbuild.context(options);
  ctx.then((c) => {
    c.watch();
    console.log('[esbuild] watching for changes...');
  });
}