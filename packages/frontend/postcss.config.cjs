module.exports = { plugins: [
  require('tailwindcss')({ config: require('node:path').join(__dirname, 'tailwind.config.cjs') }),
  require('autoprefixer')(),
  require('./scripts/font-scale.cjs')(),
] };
