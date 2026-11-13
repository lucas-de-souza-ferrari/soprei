import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AccountApp } from './AccountApp';
import { ACCOUNT_PATHS, pathForPage } from './account-flow';
import { parseCheckoutReturn, SUBSCRIPTION_PATH } from './company/billing-rules';
import { takeInviteToken } from './invite/invite-flow';
import { ContactPage } from './contact/ContactPage';
import { CONTACT_PATH } from './contact/sales-contact-rules';
import { ThemeProvider } from './theme/theme-provider';
import './style.css';

// Convite (spec 025): o token do fragmento é lido e tirado da barra UMA vez, antes de o React montar
// (o StrictMode repete efeitos e inicializadores, e o fragmento já não existiria na segunda leitura).
const inviteToken = location.pathname === pathForPage('invite') ? takeInviteToken() : null;

// Volta do checkout (spec 031, E4): a query da InfinitePay (order_nsu, transaction_nsu, slug) é lida e tirada da
// barra UMA vez, antes de o React montar; ela só dispara o "Já paguei" (o servidor confirma com o provedor) e
// nunca concede nada. Fica só em memória.
const checkoutReturn =
  location.pathname === SUBSCRIPTION_PATH ? parseCheckoutReturn(location.search) : null;
if (location.pathname === SUBSCRIPTION_PATH && location.search !== '') {
  history.replaceState(null, '', SUBSCRIPTION_PATH);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      {/* Contato comercial (spec 040, E4): página pública, fora do AccountApp (não lê a sessão). */}
      {location.pathname === CONTACT_PATH ? (
        <ContactPage />
      ) : ACCOUNT_PATHS.includes(location.pathname) || location.pathname.startsWith('/painel') ? (
        <AccountApp initialInviteToken={inviteToken} initialCheckoutReturn={checkoutReturn} />
      ) : (
        <App />
      )}
    </ThemeProvider>
  </StrictMode>,
);
