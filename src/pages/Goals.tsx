import { PageHeader } from "../components/ui";
import GlidePathSettings from "../components/GlidePathSettings";
import RebalancePanel from "../components/RebalancePanel";
import SavingsTargets from "../components/SavingsTargets";
import GoalsSettings from "../components/GoalsSettings";
import MonthlyBudgetBar from "../components/MonthlyBudgetBar";

/**
 * Goals hub: the glide-path allocation (buckets moving along a path, with a
 * tolerance band) and its to-do panel (where new money should go, band
 * corrections, what-if simulation), the medium-term savings goals, and the
 * recurring (DCA) savings goals in one place — kept out of the Forecast page
 * and the Settings page. The budget strip on top shows how much of the
 * monthly saving the goals below commit.
 *
 * The two goal cards are stacked full width, each laying its own items out in
 * an auto-filling grid — a tall medium-term goal list never towers over a
 * short DCA list (or vice versa), whatever the item counts.
 */
export default function Goals() {
  return (
    <div>
      <PageHeader
        title="Célok"
        subtitle="Célpálya, középtávú célok és rendszeres (DCA) megtakarítási célok egy helyen."
      />
      <MonthlyBudgetBar />
      <div className="mb-4 space-y-4">
        <GlidePathSettings />
        <RebalancePanel />
      </div>
      <div className="space-y-4">
        <GoalsSettings />
        <SavingsTargets />
      </div>
    </div>
  );
}
