import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AccountApp } from './AccountApp';
import { ThemeProvider } from './theme/theme-provider';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {['/entrar', '/criar-conta', '/confirmar-email'].includes(location.pathname) ||
      location.pathname.startsWith('/painel') ? (
        <AccountApp />
      ) : (
        <App />
      )}
    </ThemeProvider>
  </StrictMode>,
);
