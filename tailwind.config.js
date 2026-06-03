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
        display: ['var(--font-display)'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic':
          'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
      },
      colors: {
        // 朱墨：唯一强调 = 朱砂红（取代旧 Linear 靛蓝 primary）
        primary: '#cf4a2e',
        'primary-hover': '#e0644a',
        'primary-focus': '#b8401f',
        vermilion: '#cf4a2e',
        blueprint: '#8993a1',
        paper: '#efe6d6',
        canvas: '#100d0b',
        'surface-1': '#1a1512',
        'surface-2': '#221b16',
        'surface-3': '#221b16',
        'surface-4': '#1a1512',
        hairline: 'rgba(240,228,212,.10)',
        'hairline-strong': 'rgba(240,228,212,.18)',
        'hairline-tertiary': 'rgba(240,228,212,.24)',
        ink: '#ece3d6',
        'ink-muted': '#a39787',
        'ink-subtle': '#a39787',
        'ink-tertiary': '#6f655a',
        zinc: {
          650: '#4a4a52',
          750: '#333338',
        },
      },
      transitionDuration: {
        250: '250ms',
      },
    },
  },
  plugins: [],
}
