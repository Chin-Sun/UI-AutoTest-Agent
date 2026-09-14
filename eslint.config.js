// 代码规范检查：typescript-eslint（带类型信息）+ 代码风格 + React Hooks + Vitest 规则
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import vitest from '@vitest/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'data/**', 'components/_drafts/**', '**/*.d.ts'] },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts', 'packages/web/vite.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },

  stylistic.configs.customize({ semi: false, quotes: 'single', indent: 2, jsx: true, braceStyle: '1tbs', arrowParens: true, commaDangle: 'always-multiline' }),

  {
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
    languageOptions: { globals: { ...globals.browser } },
  },

  {
    files: ['**/test/**/*.{ts,tsx}', 'tests/**/*.ts'],
    plugins: { vitest },
    rules: { ...vitest.configs.recommended.rules },
  },

  {
    files: ['**/test/**/*.{ts,tsx}', 'tests/**/*.ts'],
    rules: {
      // vitest 的 expect(value, message) 第二个参数是失败提示
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
    },
  },

  {
    rules: {
      // 未使用变量：允许以 _ 开头的占位
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@stylistic/max-statements-per-line': ['error', { max: 2 }],
      // 该规则的自动修复会拆开行内文字并吞掉空格，改变界面文案（如“第 1 轮”→“第1 轮”）
      '@stylistic/jsx-one-expression-per-line': 'off',
    },
  },
  {
    // 需要类型信息的规则只作用于 TS 文件（JS 配置与脚本已关闭类型检查）
    files: ['**/*.{ts,tsx}'],
    rules: {
      // React 事件处理器里调用 async 函数是常见写法
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // 实现 Promise 接口（适配器、工具回调）时 async 而无 await 是正常写法
      '@typescript-eslint/require-await': 'off',
    },
  },
)
