import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AccountApp } from './AccountApp';
import { ACCOUNT_PATHS } from './account-flow';
import { ThemeProvider } from './theme/theme-provider';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {ACCOUNT_PATHS.includes(location.pathname) || location.pathname.startsWith('/painel') ? (
        <AccountApp />
      ) : (
        <App />
      )}
    </ThemeProvider>
  </StrictMode>,
);
