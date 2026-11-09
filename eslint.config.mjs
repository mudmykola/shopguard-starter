import js from '@eslint/js';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'assets/vendor/**'] },
  { ...js.configs.recommended, files: ['test/**/*.js'], languageOptions: { globals: { process: 'readonly', URL: 'readonly', require: 'readonly' } } },
];
