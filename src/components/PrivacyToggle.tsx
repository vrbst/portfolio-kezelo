import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import UnlockDialog from "./UnlockDialog";
import { usePortfolio } from "../lib/store";
import { hasLock } from "../lib/privacyLock";

export default function PrivacyToggle({
  className = "btn-ghost",
  showLabel = true,
}: {
  className?: string;
  showLabel?: boolean;
}) {
  const privacy = usePortfolio((s) => s.privacy);
  const togglePrivacy = usePortfolio((s) => s.togglePrivacy);
  const [unlocking, setUnlocking] = useState(false);
  const onClick = () => {
    if (privacy && hasLock()) setUnlocking(true);
    else togglePrivacy();
  };
  const title = privacy ? "Összegek megjelenítése" : "Összegek elrejtése";
  return (
    <>
      <button className={className} onClick={onClick} title={title} aria-label={title}>
        {privacy ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        {showLabel && (
          <span className="hidden sm:inline">{privacy ? "Megmutat" : "Elrejt"}</span>
        )}
      </button>
      {unlocking && (
        <UnlockDialog
          onClose={() => setUnlocking(false)}
          onSuccess={() => {
            setUnlocking(false);
            if (usePortfolio.getState().privacy) togglePrivacy();
          }}
        />
      )}
    </>
  );
}
