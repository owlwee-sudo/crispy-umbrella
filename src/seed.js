// Starter project created on first launch.
export const seed = {
  '/README.md': `# Welcome to Pocket Code 👋

A VS Code-style editor that lives on your phone.

- Tap ☰ to open the **Explorer**; long-press or tap ⋯ on a file for more actions.
- Tap ⋯ in the top bar (or press Ctrl+Shift+P on a keyboard) for the **Command Palette**.
- Tap ▶ to **run** the current file in a safe sandbox: Python, JavaScript, TypeScript, HTML, Markdown and SVG.
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
  '/examples/hello.py': `# Tap ▶ to run this Python program in the sandbox.
# Type answers for input() in the Input box under the output.
import math
from datetime import date

name = input("What's your name? ") or "friend"
print(f"Hi {name}! Today is {date.today():%A}.")

squares = [n * n for n in range(1, 11)]
print("Squares:", squares)
print("Square root of 2 is about", round(math.sqrt(2), 5))
`,
  '/examples/shapes.ts': `// Tap ▶ to compile and run this TypeScript file in the sandbox.
interface Shape {
  name: string;
  area(): number;
}

class Circle implements Shape {
  name = 'circle';
  constructor(private radius: number) {}
  area() {
    return Math.PI * this.radius ** 2;
  }
}

class Rect implements Shape {
  name = 'rectangle';
  constructor(private w: number, private h: number) {}
  area() {
    return this.w * this.h;
  }
}

const shapes: Shape[] = [new Circle(2), new Rect(3, 4)];
for (const s of shapes) {
  console.log(\`\${s.name}: \${s.area().toFixed(2)}\`);
}
`,
  '/examples/fizzbuzz.js': `// Tap ▶ to run this file and see the output in the console.
for (let i = 1; i <= 20; i++) {
  console.log(i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : i);
}
`,
};
