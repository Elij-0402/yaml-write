/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--sans)'],
        mono: ['var(--mono)'],
        serif: ['var(--serif)'],
      },
      colors: {
        // 冷调系统极简 —— 命名色单一源，指向 globals.css 的 CSS 变量。
        canvas: 'var(--bg)',
        panel: 'var(--bg-subtle)',
        surface: 'var(--surface)',
        raised: 'var(--surface-2)',
        fg: 'var(--fg)',
        'fg-muted': 'var(--fg-2)',
        'fg-subtle': 'var(--fg-3)',
        line: 'var(--border)',
        'line-2': 'var(--border-2)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          fg: 'var(--accent-fg)',
          subtle: 'var(--accent-subtle)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          subtle: 'var(--danger-subtle)',
        },
        success: 'var(--success)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        pop: 'var(--shadow-pop)',
      },
      transitionDuration: {
        150: '150ms',
      },
    },
  },
  plugins: [],
}
