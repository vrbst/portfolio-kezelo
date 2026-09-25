import { PageHeader } from "../components/ui";
import AiPanel from "../components/AiPanel";

export default function Ai() {
  return (
    <div>
      <PageHeader
        title="AI elemzés"
        subtitle="Egy kattintásos értékelés és beszélgetés a portfóliódról a saját Claude API-kulcsoddal. Alapból csak összesített pillanatkép megy el; részletes adatot (pl. tranzakciókat) csak a bekapcsolható eszközhasználat kér le, célzottan."
      />
      <AiPanel />
    </div>
  );
}
