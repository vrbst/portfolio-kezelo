import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { HelpView } from "./HelpView";
import { TAB_CHARTS, TAB_POSITIONS, helpSections } from "./help";

const TABS = ["Állás", "Pozíciók", "Teendők", "Célok", "Grafikon", "Hozam"] as const;

const frame = (tab: number) => {
  const { lastFrame, unmount } = render(<HelpView tab={tab} tabs={TABS} />);
  const out = lastFrame() ?? "";
  unmount();
  return out;
};

describe("help", () => {
  it("always lists the general keys, the open tab's own keys first", () => {
    for (const tab of [0, TAB_POSITIONS, 2, TAB_CHARTS]) {
      const sections = helpSections(tab);
      expect(sections[sections.length - 1].title).toBe("Mindenhol");
    }
    expect(helpSections(0)).toHaveLength(1);
    expect(helpSections(TAB_POSITIONS)[0].title).toBe("Pozíciók fül");
    expect(helpSections(TAB_CHARTS)[0].title).toBe("Grafikon fül");
  });

  it("documents the keys the app answers to", () => {
    const keys = helpSections(TAB_CHARTS).flatMap((s) => s.rows.map(([k]) => k)).join(" ");
    for (const k of ["Tab", "p", "r", "?", "q", "c / C", "t", "m"]) expect(keys).toContain(k);
  });

  it("shows the keys, the tab's section and the tab list", () => {
    const out = frame(TAB_CHARTS);
    expect(out).toContain("Súgó");
    expect(out).toContain("Grafikon fül");
    expect(out).toContain("következő / előző grafikon");
    expect(out).toContain("Mindenhol");
    expect(out).toContain("5 Grafikon");
    expect(frame(0)).not.toContain("Grafikon fül");
  });
});
