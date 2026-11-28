/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 黑灰白色板：值指向 CSS 变量，主题（dark/light）切换即时生效
        surface: {
          DEFAULT: "var(--bg)",
          bg2: "var(--bg-2)",
          panel: "var(--panel)",
          panel2: "var(--panel-2)",
        },
        line: {
          DEFAULT: "var(--line)",
          strong: "var(--line-2)",
        },
        ink: {
          DEFAULT: "var(--text)",
          muted: "var(--muted)",
          faint: "var(--faint)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          on: "var(--accent-text)",
        },
        danger: {
          DEFAULT: "var(--danger-text)",
          bg: "var(--danger-bg)",
        },
      },
      fontFamily: {
        mono: ['Consolas', '"Courier New"', 'monospace'],
      },
    },
  },
  plugins: [],
};
