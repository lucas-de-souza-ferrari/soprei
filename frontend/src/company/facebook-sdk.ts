/**
 * Facebook SDK for JavaScript, carregado **sob demanda** (spec 023): nunca entra no HTML do site nem
 * no bundle. Só é pedido quando a pessoa clica em "Conectar com a Meta" na tela do canal. Um SDK
 * adulterado teria o poder de uma XSS nesta página; por isso ele só carrega aqui, só para quem pode
 * conectar, só depois do clique, sem `xfbml` e sem eventos automáticos.
 */
const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
const SCRIPT_ID = 'facebook-jssdk';
const LOAD_TIMEOUT_MS = 15_000;

export interface FacebookLoginOptions {
  readonly config_id: string;
  readonly response_type: 'code';
  readonly override_default_response_type: true;
  readonly extras: { readonly setup: Record<string, never> };
}

export interface FacebookLoginResponse {
  readonly authResponse?: { readonly code?: unknown } | null;
}

export interface FacebookApi {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(callback: (response: FacebookLoginResponse) => void, options: FacebookLoginOptions): void;
}

declare global {
  interface Window {
    FB?: FacebookApi;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FacebookApi> | null = null;

/**
 * Carrega o SDK uma única vez (chamar de novo devolve a mesma promessa e nunca duplica o `<script>`).
 * Falha de rede ou bloqueador de conteúdo remove o `<script>` com erro e libera uma nova tentativa.
 */
export function loadFacebookSdk(config: {
  readonly appId: string;
  readonly graphApiVersion: string;
}): Promise<FacebookApi> {
  if (loading !== null) return loading;
  const attempt = new Promise<FacebookApi>((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => giveUp(), LOAD_TIMEOUT_MS);
    const giveUp = (): void => {
      clearTimeout(timer);
      script.remove();
      delete window.fbAsyncInit;
      loading = null;
      reject(new Error('sdk'));
    };
    window.fbAsyncInit = () => {
      const fb = window.FB;
      if (fb === undefined) {
        giveUp();
        return;
      }
      // Sem plugins (`xfbml`) e sem eventos enviados à Meta (`autoLogAppEvents`).
      fb.init({
        appId: config.appId,
        autoLogAppEvents: false,
        xfbml: false,
        version: config.graphApiVersion,
      });
      clearTimeout(timer);
      resolve(fb);
    };
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = SDK_URL;
    script.onerror = giveUp;
    document.head.append(script);
  });
  loading = attempt;
  return attempt;
}

/**
 * Chama `FB.login` e diz se o navegador bloqueou o popup. Precisa rodar **de forma síncrona dentro do
 * manipulador do clique** (sem `await` antes): o Safari e outros bloqueiam popup aberto depois de
 * espera. O bloqueio é detectado observando o retorno de `window.open` só durante a chamada síncrona.
 */
export function startFacebookLogin(
  fb: FacebookApi,
  options: FacebookLoginOptions,
  callback: (response: FacebookLoginResponse) => void,
): { popupBlocked: boolean } {
  const original = window.open;
  let popupBlocked = false;
  window.open = (...args: Parameters<typeof window.open>) => {
    const opened = original.apply(window, args);
    if (opened === null) popupBlocked = true;
    return opened;
  };
  try {
    fb.login(callback, options);
  } finally {
    window.open = original;
  }
  return { popupBlocked };
}
