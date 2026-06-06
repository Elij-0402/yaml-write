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
        sans: ['var(--font-sans)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic':
          'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
      },
      colors: {
        // 活字 · Living Type —— 命名色单一源，指向 globals.css 的 CSS 变量。
        // 主行动 = 墨黑实心；text-primary / hover:text-primary 一律落墨黑（不再变红）。
        primary: 'var(--ink)',
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        shell: 'var(--shell)',
        well: 'var(--well)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        hairline: 'var(--hair)',
        signal: 'var(--signal)',
        danger: 'var(--danger)',
      },
      transitionDuration: {
        250: '250ms',
      },
    },
  },
  plugins: [],
}
