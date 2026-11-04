import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AccountApp } from './AccountApp';
import { ACCOUNT_PATHS, pathForPage } from './account-flow';
import { takeInviteToken } from './invite/invite-flow';
import { ThemeProvider } from './theme/theme-provider';
import './style.css';

// Convite (spec 025): o token do fragmento é lido e tirado da barra UMA vez, antes de o React montar
// (o StrictMode repete efeitos e inicializadores, e o fragmento já não existiria na segunda leitura).
const inviteToken = location.pathname === pathForPage('invite') ? takeInviteToken() : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {ACCOUNT_PATHS.includes(location.pathname) || location.pathname.startsWith('/painel') ? (
        <AccountApp initialInviteToken={inviteToken} />
      ) : (
        <App />
      )}
    </ThemeProvider>
  </StrictMode>,
);
