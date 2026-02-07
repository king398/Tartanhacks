import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        graphite: "#1a2233",
        mist: "#f4f7fc",
        muted: "#55627a",
        teal: "#2fa8bf",
        lightblue: "#8fd8ff",
        lavender: "#9673ff",
        coral: "#ff6f61",
        amber: "#ffc75f",
      },
      boxShadow: {
        glass: "0 16px 44px rgba(27, 40, 64, 0.12)",
      },
      fontFamily: {
        sans: ["DM Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Sora", "DM Sans", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        floatIn: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        floatIn: "floatIn 420ms ease forwards",
      },
    },
  },
  plugins: [],
};

export default config;
