// Starter project created on first launch.
export const seed = {
  '/README.md': `# Welcome to Pocket Code 👋

A VS Code-style editor that lives on your phone.

- Tap ☰ to open the **Explorer**; long-press or tap ⋯ on a file for more actions.
- Tap ⋯ in the top bar (or press Ctrl+Shift+P on a keyboard) for the **Command Palette**.
- Tap ▶ to **run** the current HTML or JavaScript file.
- The row of keys above your keyboard has Tab, brackets, arrows, copy/paste and more.
- Everything saves automatically on your device.
`,
  '/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>Hello from Pocket Code</h1>
      <button id="btn">Tap me</button>
      <p id="out"></p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`,
  '/style.css': `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
  background: linear-gradient(135deg, #1e3a8a, #7c3aed);
  color: white;
}

button {
  font: inherit;
  padding: 0.75rem 1.5rem;
  border: 0;
  border-radius: 999px;
  background: white;
  color: #1e3a8a;
}
`,
  '/script.js': `let count = 0;

document.getElementById('btn').addEventListener('click', () => {
  count++;
  document.getElementById('out').textContent = \`Tapped \${count} time\${count === 1 ? '' : 's'}\`;
  console.log('count is now', count);
});
`,
  '/examples/fizzbuzz.js': `// Tap ▶ to run this file and see the output in the console.
for (let i = 1; i <= 20; i++) {
  console.log(i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : i);
}
`,
};
