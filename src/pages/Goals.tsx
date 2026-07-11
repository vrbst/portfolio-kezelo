import { PageHeader } from "../components/ui";
import AllocationTargets from "../components/AllocationTargets";
import SavingsTargets from "../components/SavingsTargets";
import GoalsSettings from "../components/GoalsSettings";

/**
 * Goals hub: the target allocation (with the buy-only DCA helper), the
 * medium-term savings goals, and the recurring (DCA) savings goals in one place
 * — kept out of the Forecast page and the Settings page.
 */
export default function Goals() {
  return (
    <div>
      <PageHeader
        title="Célok"
        subtitle="Cél-allokáció, középtávú célok és rendszeres (DCA) megtakarítási célok egy helyen."
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <AllocationTargets />
        <SavingsTargets />
      </div>
      <div className="mt-4">
        <GoalsSettings />
      </div>
    </div>
  );
}
