// The help layer: replaces the tab's content while it is open.

import { Box, Text } from "ink";
import { helpSections } from "./help";

export function HelpView({ tab, tabs }: { tab: number; tabs: readonly string[] }) {
  const sections = helpSections(tab);
  const width = Math.max(...sections.flatMap((s) => s.rows.map(([k]) => k.length)));
  return (
    <Box flexDirection="column">
      <Text bold>Súgó</Text>
      {sections.map((s) => (
        <Box key={s.title} marginTop={1} flexDirection="column">
          <Text bold>{s.title}</Text>
          {s.rows.map(([keys, what]) => (
            <Text key={keys}>
              <Text color="cyan">{keys.padEnd(width)}</Text> {what}
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Fülek</Text>
        <Text>{tabs.map((t, i) => `${i + 1} ${t}`).join(" · ")}</Text>
      </Box>
    </Box>
  );
}
