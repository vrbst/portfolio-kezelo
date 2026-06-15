import { PageHeader } from '../components/ui'
import AiPanel from '../components/AiPanel'

export default function Ai() {
  return (
    <div>
      <PageHeader
        title="AI elemzés"
        subtitle="Egy kattintásos értékelés és szabad kérdés-válasz a portfóliódról a saját Claude API-kulcsoddal. Csak aggregált adatok kerülnek elküldésre, tranzakciók soha."
      />
      <AiPanel />
    </div>
  )
}
