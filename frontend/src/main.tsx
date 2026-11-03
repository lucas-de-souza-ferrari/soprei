import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AccountApp } from './AccountApp';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {['/entrar', '/criar-conta', '/confirmar-email'].includes(location.pathname) ||
    location.pathname.startsWith('/painel') ? (
      <AccountApp />
    ) : (
      <App />
    )}
  </StrictMode>,
);
