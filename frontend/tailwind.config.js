/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        bebas: ['BebasNeue', 'sans-serif'], // имя шрифта, указанное в @font-face
      },
    },
  },
  plugins: [],
}