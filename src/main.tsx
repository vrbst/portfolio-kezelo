import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App'
import Dashboard from './pages/Dashboard'
import Accounts from './pages/Accounts'
import AccountDetail from './pages/AccountDetail'
import Import from './pages/Import'
import Income from './pages/Income'
import Calendar from './pages/Calendar'
import Alerts from './pages/Alerts'
import Ai from './pages/Ai'
import Settings from './pages/Settings'

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'accounts', element: <Accounts /> },
      { path: 'accounts/:id', element: <AccountDetail /> },
      { path: 'income', element: <Income /> },
      { path: 'calendar', element: <Calendar /> },
      { path: 'alerts', element: <Alerts /> },
      { path: 'ai', element: <Ai /> },
      { path: 'import', element: <Import /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
