// Run: npm run tui
import { render } from "ink";
import { App } from "./App";

// Alternate screen (like mc, vim): the terminal's history stays untouched and
// comes back on exit. Entered here, not with Ink's option, so the screen is
// cleared and the cursor homed first — otherwise (Windows Terminal) the app
// starts drawing where the prompt was and fills only the lower part.
const out = process.stdout;
if (out.isTTY) {
  out.write("\x1b[?1049h\x1b[2J\x1b[H");
  process.on("exit", () => out.write("\x1b[?1049l"));
}

const app = render(<App />);
await app.waitUntilExit();
