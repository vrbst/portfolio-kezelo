import { PageHeader } from "../components/ui";
import AllocationTargets from "../components/AllocationTargets";
import SavingsTargets from "../components/SavingsTargets";
import GoalsSettings from "../components/GoalsSettings";
import MonthlyBudgetBar from "../components/MonthlyBudgetBar";

/**
 * Goals hub: the target allocation (with the buy-only DCA helper), the
 * medium-term savings goals, and the recurring (DCA) savings goals in one place
 * — kept out of the Forecast page and the Settings page. The budget strip on
 * top shows how much of the monthly saving the goals below commit.
 */
export default function Goals() {
  return (
    <div>
      <PageHeader
        title="Célok"
        subtitle="Cél-allokáció, középtávú célok és rendszeres (DCA) megtakarítási célok egy helyen."
      />
      <MonthlyBudgetBar />
      {/* Left: the two compact cards stacked (allocation + DCA), so they fill
          the height of the taller medium-term goals card on the right. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <AllocationTargets />
          <GoalsSettings />
        </div>
        <SavingsTargets />
      </div>
    </div>
  );
}
