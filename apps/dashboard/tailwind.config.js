/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'var(--color-surface)',
          raised: 'var(--color-surface-raised)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
        },
        // New semantic color tokens
        eve: {
          bg0: 'var(--bg-0)',
          bg1: 'var(--bg-1)',
          bg2: 'var(--bg-2)',
          bg3: 'var(--bg-3)',
          bg4: 'var(--bg-4)',
          border: 'var(--border)',
          'border-bright': 'var(--border-bright)',
          blue: 'var(--blue)',
          'blue-dim': 'var(--blue-dim)',
          green: 'var(--green)',
          'green-dim': 'var(--green-dim)',
          amber: 'var(--amber)',
          'amber-dim': 'var(--amber-dim)',
          red: 'var(--red)',
          'red-dim': 'var(--red-dim)',
          purple: 'var(--purple)',
          'purple-dim': 'var(--purple-dim)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        label: '12px',
        body: '13px',
        emphasis: '14px',
        section: '18px',
        page: '24px',
      },
    },
  },
  plugins: [],
};
