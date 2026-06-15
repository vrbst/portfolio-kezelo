import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import Sidebar from './components/Sidebar'
import MobileNav from './components/MobileNav'
import InstallPrompt from './components/InstallPrompt'
import { usePortfolio } from './lib/store'

/** Re-fetch live prices at most this often when refreshing on tab focus. */
const REFRESH_MS = 5 * 60 * 1000

export default function App() {
  const location = useLocation()
  const load = usePortfolio((s) => s.load)
  const loaded = usePortfolio((s) => s.loaded)
  const privacy = usePortfolio((s) => s.privacy)
  const refreshPrices = usePortfolio((s) => s.refreshPrices)

  useEffect(() => {
    load()
  }, [load])

  // Keep prices fresh: poll every 5 minutes, and whenever the user returns to
  // the tab (but not more often than REFRESH_MS, to avoid a focus storm).
  useEffect(() => {
    let last = Date.now()
    const refresh = () => {
      last = Date.now()
      void refreshPrices()
    }
    const id = setInterval(refresh, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > REFRESH_MS)
        refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refreshPrices])

  useEffect(() => {
    document.documentElement.classList.toggle('privacy-on', privacy)
  }, [privacy])

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0">
        <div className="mx-auto max-w-7xl px-5 py-8 pb-24 sm:px-8 md:pb-8">
          {!loaded ? (
            <div className="flex h-[60vh] items-center justify-center text-[var(--color-muted)]">
              Betöltés…
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </main>
      <MobileNav />
      <InstallPrompt />
    </div>
  )
}
