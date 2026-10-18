// Run: npm run tui
import { render } from "ink";
import { App } from "./App";

// Alternate screen (like mc, vim): the terminal's history stays untouched and
// comes back on exit.
render(<App />, { alternateScreen: true });
