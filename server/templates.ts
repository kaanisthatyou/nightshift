// Starters. A cheap model asked to build a React site from an empty folder spends
// its first twenty minutes writing vite config from memory, getting a version
// wrong, and falling back to one big index.html. None of that is the product.
// So the floor lays the skeleton down itself - config, entry point, installed
// dependencies - before any desk sits down, and every desk is told exactly what
// is already there and how to use it.
import fs from "node:fs";
import path from "node:path";

export interface StackTemplate {
  id: string;
  name: string;
  /** what the planner reads when choosing */
  pitch: string;
  /** files laid down before anyone starts, relative to the folder */
  files: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** the check the whole project has to pass */
  verify: string;
  /** a type check a single desk can run over its own files */
  typecheck: string | null;
  /** handed to every desk working on this stack, under the brief */
  guide: string;
}

const REACT_GUIDE = `Stack (already installed and configured - do not reinstall, do not rewrite config):
- React 19 + TypeScript (strict) + Vite 6. Entry: src/main.tsx renders <App /> from src/App.tsx into #root.
- Tailwind CSS v4 through @tailwindcss/vite. src/index.css starts with @import "tailwindcss"; and defines design tokens in an @theme block (e.g. --color-accent: #...; becomes the class bg-accent / text-accent; --font-display becomes font-display). There is NO tailwind.config.js in v4 - never create one.
- lucide-react for icons: import { ArrowRight, Github } from "lucide-react". Use real icon names only.
- motion for animation: import { motion } from "motion/react". Keep animation subtle: fade/slide 8-24px, 0.4-0.7s, whileInView with viewport={{ once: true }}.
- No other packages are installed. Do not import anything else.

Code rules:
- Function components with typed props. Named exports for components unless the contract says default.
- Import with relative paths and no file extension: import { Hero } from "./components/Hero".
- Type-only imports use "import type".
- Data and copy that several components share lives in the data file the contract names - import it, never duplicate it.
- Images: never link to image hosts that may not exist. Use CSS gradients, inline SVG, or initials/monograms for avatars and project thumbnails - designed to look intentional.

Design bar - this has to look like a studio shipped it, not like a tutorial:
- One confident palette from the contract: a neutral base (near-black or warm off-white), one accent, used sparingly. No rainbow gradients, no default blue.
- Typography does the heavy lifting: a display face for headings with tight tracking (tracking-tight), large sizes on hero (text-5xl md:text-7xl), comfortable body (text-base/relaxed md:text-lg), muted secondary text.
- Rhythm, not emptiness: sections py-20 md:py-28 (the section wrapper owns that padding - never add more around it), content in a max-w-6xl mx-auto px-6 container, grids with gap-6 to gap-8. The hero fits its content (min-h-[80vh] at most) - no screen-tall blank areas anywhere.
- Vary the rhythm down the page: alternate a full-bleed or tinted band (bg-surface, or the dark ink colour with light text) with plain sections, mix grid layouts (asymmetric 5/7 splits, bento cards) instead of repeating one centred column.
- No large empty boxes. Every image slot - project thumbnail, portrait, device shot - is a designed illustration built in JSX: a browser or phone frame (rounded rect, three dots, a URL bar) containing a miniature UI made of divs (nav bar, headline bars, cards, a chart of bars, avatars as coloured circles, buttons), tinted with that project's colour. A portrait is an abstract composition (monogram over layered shapes and a subtle pattern), never a grey rectangle.
- You never see the rendered page, so layout must be correct by construction: anything "absolute" sits inside a "relative" parent in the same component; decorative overlaps stay inside their own box (overflow-hidden on that box); no negative margins between sections; illustrations get a fixed aspect ratio (aspect-[4/3] and the like) so they cannot collapse or spill.
- Details that signal craft: hairline borders (border-line), subtle shadows on hover, small uppercase eyebrow labels, numbers set in the display face, arrow icons that nudge on hover (group-hover:translate-x-1), sticky translucent nav (backdrop-blur).
- Every interactive element has hover and focus-visible states (transition-colors, ring). Links and buttons feel clickable.
- Responsive from 360px up: stack on mobile, grid on md/lg. No horizontal scroll.
- Semantic HTML: header/nav/main/section/footer, one h1, section ids matching the nav anchors, alt text, aria-labels on icon-only buttons.
- Real, specific copy written for this project - names, numbers, dates, outcomes. Never lorem ipsum, never "Project 1", never "Your text here".`;

const react: StackTemplate = {
  id: "react-vite",
  name: "React + Vite + Tailwind",
  pitch: "React 19, TypeScript, Vite, Tailwind v4, lucide-react icons, motion animations. For websites, landing pages, dashboards, SPAs.",
  verify: "npm run build",
  typecheck: "npx tsc --noEmit -p .",
  guide: REACT_GUIDE,
  dependencies: {
    react: "^19.1.0",
    "react-dom": "^19.1.0",
    "lucide-react": "^0.525.0",
    motion: "^12.23.0",
  },
  devDependencies: {
    "@tailwindcss/vite": "^4.1.11",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^4.6.0",
    tailwindcss: "^4.1.11",
    typescript: "~5.8.3",
    vite: "^6.3.5",
  },
  files: {
    "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    "src/App.tsx": `export default function App() {
  return <main />;
}
`,
    "src/index.css": `@import "tailwindcss";
`,
    ".gitignore": "node_modules\ndist\n",
  },
};

const vanilla: StackTemplate = {
  id: "vanilla-vite",
  name: "TypeScript + Vite (no framework)",
  pitch: "Plain TypeScript and CSS bundled by Vite. For canvas games, small interactive toys, and pages where a framework is dead weight.",
  verify: "npm run build",
  typecheck: "npx tsc --noEmit -p .",
  guide: `Stack (already installed and configured):
- TypeScript (strict) + Vite 6, no framework. Entry: index.html loads src/main.ts. Styles in src/style.css, imported from main.ts.
- No packages beyond typescript and vite. Use the DOM and Canvas APIs directly.

Code rules:
- ES modules, relative imports without extensions. Small modules with one job each; export what the contract names.
- requestAnimationFrame for loops, with a fixed-timestep update where the game needs it. No setInterval game loops.
- Everything visible must be finished: real title, real instructions, a start state, an end state, restart.`,
  dependencies: {},
  devDependencies: { typescript: "~5.8.3", vite: "^6.3.5" },
  files: {
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    "src/main.ts": `import "./style.css";
`,
    "src/style.css": "",
    ".gitignore": "node_modules\ndist\n",
  },
};

const node: StackTemplate = {
  id: "node-api",
  name: "Node API (Express + TypeScript)",
  pitch: "Express 5 with TypeScript run through tsx, zod for validation. For APIs, bots, CLIs and backends.",
  verify: "npm run build",
  typecheck: "npx tsc --noEmit -p .",
  guide: `Stack (already installed and configured):
- Node 22, TypeScript (strict), Express 5, zod. Run with tsx: src/index.ts is the entry. "npm run build" is a type check.
- ES modules ("type": "module"). Relative imports WITH the .js extension is not needed - tsx resolves .ts; write imports without extension.

Code rules:
- Validate every request body with zod at the route. Return JSON errors with real status codes.
- Keep state behind a small module with typed functions; routes stay thin.
- No secrets in code - read from process.env with a clear error when missing.`,
  dependencies: { express: "^5.1.0", zod: "^3.25.0" },
  devDependencies: { "@types/express": "^5.0.3", "@types/node": "^22.15.0", tsx: "^4.20.0", typescript: "~5.8.3" },
  files: {
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
`,
    "src/index.ts": `console.log("starting");
`,
    ".gitignore": "node_modules\n",
  },
};

const plain: StackTemplate = {
  id: "static",
  name: "Static HTML/CSS/JS",
  pitch: "No build step at all. Only when the user explicitly wants a single static page with no tooling.",
  verify: "",
  typecheck: null,
  guide: `Stack: plain HTML, CSS and JavaScript files, no build step, no packages. Pages link their CSS and JS with relative paths.
Write modern CSS (custom properties, grid, clamp()) and ES modules (<script type="module">).`,
  dependencies: {},
  devDependencies: {},
  files: {},
};

export const STACKS: StackTemplate[] = [react, vanilla, node, plain];

export const stack = (id: string | null | undefined) => STACKS.find((s) => s.id === id);

/** What the planner is shown so it can pick. */
export function stackMenu(): string {
  return STACKS.map((s) => `- ${s.id}: ${s.pitch}`).join("\n");
}

/**
 * Lay a stack down in a folder that has no project yet. A folder that already
 * has a package.json is somebody's project: nothing is overwritten, and the
 * desks work with what is there.
 */
export function scaffold(root: string, s: StackTemplate, name: string, extraDeps: string[] = []): { wrote: string[]; skipped: boolean } {
  if (s.id === "static") return { wrote: [], skipped: false };
  const manifest = path.join(root, "package.json");
  if (fs.existsSync(manifest)) return { wrote: [], skipped: true };

  const deps = { ...s.dependencies };
  for (const d of extraDeps) {
    const m = String(d).trim().match(/^(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)(?:@(.+))?$/i);
    if (m && !deps[m[1]] && !s.devDependencies[m[1]]) deps[m[1]] = m[2] ?? "latest";
  }
  const pkg = {
    name: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "app",
    private: true,
    version: "0.1.0",
    type: "module",
    scripts:
      s.id === "node-api"
        ? { dev: "tsx watch src/index.ts", start: "tsx src/index.ts", build: "tsc --noEmit" }
        : { dev: "vite", build: "tsc --noEmit -p . && vite build", preview: "vite preview" },
    dependencies: deps,
    devDependencies: s.devDependencies,
  };
  const wrote: string[] = [];
  fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
  wrote.push("package.json");
  for (const [rel, body] of Object.entries(s.files)) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    wrote.push(rel);
  }
  return { wrote, skipped: false };
}
